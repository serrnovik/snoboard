import { describe, expect, it, vi } from "vitest";
import {
  enrichPulls,
  GITHUB_ENRICH_BUDGET_MS,
  GITHUB_ENRICH_CONCURRENCY,
  GITHUB_FETCH_TIMEOUT_MS,
  resetForgeCache,
} from "./github.js";

const repo = "acme/widgets";
const token = "test-token";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function pullFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://api.github.com/repos/acme/widgets/pulls/12") {
      return jsonResponse({ state: "open", merged: false, head: { sha: "abc1234" } });
    }
    if (url === "https://api.github.com/repos/acme/widgets/commits/abc1234/status") {
      return jsonResponse({ state: "success" });
    }
    return jsonResponse({ message: "missing" }, 404);
  });
}

describe("GitHub pull request enrichment", () => {
  it("does not call GitHub without a token", async () => {
    const fetchImpl = vi.fn();
    const result = await enrichPulls({
      repo,
      token: undefined,
      pullNumbers: [12],
      fetchImpl,
    });
    expect(result).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns state, merged, and combined check status", async () => {
    resetForgeCache();
    const fetchImpl = pullFetch();
    const result = await enrichPulls({
      repo,
      token,
      pullNumbers: [12, 12],
      fetchImpl,
      now: 1_000,
    });
    expect(result).toEqual({
      "12": { state: "open", merged: false, checks: "success" },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const first = fetchImpl.mock.calls[0];
    expect(first?.[0]).toBe("https://api.github.com/repos/acme/widgets/pulls/12");
    const init = first?.[1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer test-token");
  });

  it("reuses a result for five minutes", async () => {
    resetForgeCache();
    const fetchImpl = pullFetch();
    await enrichPulls({ repo, token, pullNumbers: [12], fetchImpl, now: 10_000 });
    fetchImpl.mockClear();
    const cached = await enrichPulls({ repo, token, pullNumbers: [12], fetchImpl, now: 20_000 });
    expect(cached?.["12"]?.checks).toBe("success");
    expect(fetchImpl).not.toHaveBeenCalled();
    const again = await enrichPulls({
      repo,
      token,
      pullNumbers: [12],
      fetchImpl,
      now: 10_000 + 5 * 60 * 1000,
    });
    expect(again?.["12"]?.state).toBe("open");
    expect(fetchImpl).toHaveBeenCalled();
  });

  it("skips pull requests whose GitHub requests never settle", async () => {
    resetForgeCache();
    expect(GITHUB_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(GITHUB_ENRICH_BUDGET_MS).toBe(15_000);
    expect(GITHUB_ENRICH_CONCURRENCY).toBe(4);
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {}));
    const result = await enrichPulls({
      repo,
      token,
      pullNumbers: [1, 2, 3, 4, 5, 6],
      fetchImpl,
      now: 1_000,
      fetchTimeoutMs: 500,
      budgetMs: 40,
      concurrency: GITHUB_ENRICH_CONCURRENCY,
    });
    expect(result).toEqual({});
    expect(fetchImpl).toHaveBeenCalledTimes(GITHUB_ENRICH_CONCURRENCY);
    for (const call of fetchImpl.mock.calls) {
      const init = call[1] as RequestInit | undefined;
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.signal?.aborted).toBe(true);
    }
  });
});
