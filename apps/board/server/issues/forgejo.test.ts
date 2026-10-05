import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createForgejoProvider } from "./forgejo.js";
import type { IssueRef } from "./provider.js";

const token = "forgejo-read-token";
const signal = new AbortController().signal;
const dirs: string[] = [];
const base = "https://forge.example.com";

function tokenFile(contents = `${token}\n`): string {
  const dir = mkdtempSync(join(tmpdir(), "snoboard-forgejo-"));
  dirs.push(dir);
  const file = join(dir, "token");
  writeFileSync(file, contents, "utf8");
  return file;
}

/** `fj#12` or `fj:owner/name#3` as the parser produces it. */
function ref(raw: string): IssueRef {
  return { provider: "fj", key: raw.slice(3), raw };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Forgejo provider", () => {
  it("links without a token and never calls Forgejo", async () => {
    const fetchImpl = vi.fn();
    const provider = createForgejoProvider({ baseUrl: `${base}/`, repo: "acme/widgets", fetchImpl });
    expect(provider.linkFor(ref("fj#12"))).toBe(`${base}/acme/widgets/issues/12`);
    expect(provider.linkFor(ref("fj:other/thing#3"))).toBe(`${base}/other/thing/issues/3`);
    const states = await provider.fetchStates([ref("fj#12")], signal);
    expect(states.get("fj#12")).toEqual({
      raw: "fj#12",
      title: "",
      state: "unknown",
      url: `${base}/acme/widgets/issues/12`,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads open and closed issues with a GET and the token header", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, _init?: RequestInit) =>
      String(url).endsWith("/12")
        ? jsonResponse({
            title: "Open one",
            state: "open",
            html_url: `${base}/acme/widgets/issues/12`,
            updated_at: "2026-09-02T00:00:00Z",
          })
        : jsonResponse({ title: "Merged PR", state: "closed", html_url: `${base}/other/thing/pulls/3` }),
    );
    const provider = createForgejoProvider({ baseUrl: base, repo: "acme/widgets", tokenFile: tokenFile(), fetchImpl });
    const states = await provider.fetchStates([ref("fj#12"), ref("fj:other/thing#3")], signal);
    expect(states.get("fj#12")).toEqual({
      raw: "fj#12",
      title: "Open one",
      state: "open",
      url: `${base}/acme/widgets/issues/12`,
      updatedAt: "2026-09-02T00:00:00Z",
    });
    expect(states.get("fj:other/thing#3")).toMatchObject({ state: "closed", url: `${base}/other/thing/pulls/3` });
    const urls = fetchImpl.mock.calls.map((call) => String(call[0])).sort();
    expect(urls).toEqual([`${base}/api/v1/repos/acme/widgets/issues/12`, `${base}/api/v1/repos/other/thing/issues/3`]);
    for (const call of fetchImpl.mock.calls) {
      const init = call[1] as RequestInit;
      expect(init.method).toBe("GET");
      expect(init.redirect).toBe("error");
      expect(new Headers(init.headers).get("authorization")).toBe(`token ${token}`);
    }
    expect(JSON.stringify([...states.values()])).not.toContain(token);
  });

  it("ignores html_url on another host and scrubs the token from titles", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ title: `leak ${token}`, state: "open", html_url: "https://evil.example.org/acme/widgets/issues/12" }),
    );
    const provider = createForgejoProvider({ baseUrl: base, repo: "acme/widgets", tokenFile: tokenFile(), fetchImpl });
    const state = (await provider.fetchStates([ref("fj#12")], signal)).get("fj#12");
    expect(state).toEqual({ raw: "fj#12", title: "", state: "open", url: `${base}/acme/widgets/issues/12` });
  });

  it("returns unknown on errors and unexpected states", async () => {
    const missing = createForgejoProvider({
      baseUrl: base,
      repo: "acme/widgets",
      tokenFile: tokenFile(),
      fetchImpl: vi.fn(async () => jsonResponse({ message: "not found" }, 404)),
    });
    expect((await missing.fetchStates([ref("fj#9")], signal)).get("fj#9")).toMatchObject({ state: "unknown" });
    const odd = createForgejoProvider({
      baseUrl: base,
      repo: "acme/widgets",
      tokenFile: tokenFile(),
      fetchImpl: vi.fn(async () => jsonResponse({ title: "x", state: "weird" })),
    });
    expect((await odd.fetchStates([ref("fj#9")], signal)).get("fj#9")).toMatchObject({ state: "unknown" });
  });

  it("refuses an http base and handles only fj refs", () => {
    const fetchImpl = vi.fn();
    const insecure = createForgejoProvider({ baseUrl: "http://forge.example.com", repo: "acme/widgets", fetchImpl });
    expect(insecure.parseRef(ref("fj#1"))).toBe(false);
    expect(insecure.linkFor(ref("fj#1"))).toBe("");
    const provider = createForgejoProvider({ baseUrl: base, repo: "acme/widgets", fetchImpl });
    expect(provider.parseRef({ provider: "gh", key: "1", raw: "gh#1" })).toBe(false);
    expect(provider.parseRef(ref("fj#1"))).toBe(true);
  });
});
