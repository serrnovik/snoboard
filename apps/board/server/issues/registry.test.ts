import { describe, expect, it } from "vitest";
import type { IssueProvider, IssueRef, IssueState } from "./provider.js";
import {
  createIssueRegistry,
  ISSUE_CACHE_TTL_MS,
  ISSUE_FETCH_BUDGET_MS,
  ISSUE_FETCH_CONCURRENCY,
  ISSUE_FETCH_TIMEOUT_MS,
} from "./registry.js";

function ref(raw: string, provider: string, key: string): IssueRef {
  return { provider, key, raw };
}

function state(raw: string, title: string, value: IssueState["state"] = "open"): IssueState {
  return { raw, title, state: value, url: `https://example.test/${raw}` };
}

function provider(id: string, fetchStates: IssueProvider["fetchStates"]): IssueProvider {
  return {
    id,
    parseRef: (item) => item.provider === id,
    linkFor: (item) => `https://example.test/${id}/${item.key}`,
    fetchStates,
  };
}

describe("issue registry", () => {
  it("uses a five minute cache, a ten second call timeout, a fifteen second budget, and concurrency 4", () => {
    expect(ISSUE_CACHE_TTL_MS).toBe(5 * 60 * 1000);
    expect(ISSUE_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(ISSUE_FETCH_BUDGET_MS).toBe(15_000);
    expect(ISSUE_FETCH_CONCURRENCY).toBe(4);
  });

  it("returns a cached state without calling the provider again", async () => {
    let calls = 0;
    let clock = 1_000;
    const gh = provider("gh", async (refs) => {
      calls += 1;
      return new Map(refs.map((item) => [item.raw, state(item.raw, "Widget")]));
    });
    const registry = createIssueRegistry([gh], { now: () => clock });
    const item = ref("gh#12", "gh", "12");

    await registry.fetchStates([item]);
    clock = 2_000;
    const cached = await registry.fetchStates([item]);
    expect(cached.get("gh#12")).toMatchObject({ title: "Widget", state: "open" });
    expect(calls).toBe(1);

    clock = 1_000 + ISSUE_CACHE_TTL_MS;
    await registry.fetchStates([item]);
    expect(calls).toBe(2);
  });

  it("does not cache an unknown answer", async () => {
    let calls = 0;
    const gh = provider("gh", async () => {
      calls += 1;
      return new Map();
    });
    const registry = createIssueRegistry([gh], { now: () => 1_000 });
    const item = ref("gh#12", "gh", "12");
    expect((await registry.fetchStates([item])).get("gh#12")?.state).toBe("unknown");
    expect((await registry.fetchStates([item])).get("gh#12")?.state).toBe("unknown");
    expect(calls).toBe(2);
  });

  it("turns a provider that exceeds the per-call timeout into unknown", async () => {
    const gh = provider("gh", () => new Promise(() => {}));
    const registry = createIssueRegistry([gh], { timeoutMs: 30, budgetMs: 5_000 });
    const started = Date.now();
    const states = await registry.fetchStates([ref("gh#1", "gh", "1")]);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(states.get("gh#1")).toMatchObject({
      state: "unknown",
      url: "https://example.test/gh/1",
    });
  });

  it("returns before the budget when a provider never responds", async () => {
    let fastCalls = 0;
    const slow = provider("slow", () => new Promise(() => {}));
    const fast = provider("fast", async (refs) => {
      fastCalls += 1;
      return new Map(refs.map((item) => [item.raw, state(item.raw, "Fast")]));
    });
    const registry = createIssueRegistry([slow, fast], {
      timeoutMs: 60_000,
      budgetMs: 50,
      concurrency: ISSUE_FETCH_CONCURRENCY,
    });
    const started = Date.now();
    const states = await registry.fetchStates([
      ref("slow:1", "slow", "1"),
      ref("fast:2", "fast", "2"),
    ]);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(states.get("slow:1")?.state).toBe("unknown");
    expect(states.get("fast:2")).toMatchObject({ title: "Fast", state: "open" });
    expect(fastCalls).toBe(1);
  });

  it("reports an unknown provider without calling anyone", async () => {
    let calls = 0;
    const gh = provider("gh", async () => {
      calls += 1;
      return new Map();
    });
    const registry = createIssueRegistry([gh]);
    const item = ref("linear:ABC-1", "linear", "ABC-1");
    expect(registry.linkFor(item)).toBeUndefined();
    const states = await registry.fetchStates([item]);
    expect(states.get("linear:ABC-1")).toEqual({
      raw: "linear:ABC-1",
      title: "",
      state: "unknown",
      url: "",
    });
    expect(calls).toBe(0);
  });

  it("links through the matching provider without a network call", () => {
    const gh = provider("gh", async () => new Map());
    const registry = createIssueRegistry([gh]);
    expect(registry.linkFor(ref("gh#4", "gh", "4"))).toBe("https://example.test/gh/4");
  });
});
