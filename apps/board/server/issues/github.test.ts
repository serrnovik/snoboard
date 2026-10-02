import { describe, expect, it, vi } from "vitest";
import { createGithubIssueProvider } from "./github.js";
import type { IssueRef } from "./provider.js";

const token = "snoboard-test-token";
const signal = new AbortController().signal;

function ref(raw: string, key: string): IssueRef {
  return { provider: "gh", key, raw };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("GitHub issue provider", () => {
  it("links to the issue without using the network", () => {
    const fetchImpl = vi.fn();
    const provider = createGithubIssueProvider({ defaultRepo: "acme/widgets", token, fetchImpl });
    expect(provider.linkFor(ref("gh#12", "12"))).toBe("https://github.com/acme/widgets/issues/12");
    expect(provider.linkFor(ref("gh:other/widgets#7", "other/widgets#7"))).toBe(
      "https://github.com/other/widgets/issues/7",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads an open issue, including one that is a pull request", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://api.github.com/repos/acme/widgets/issues/12") {
        return jsonResponse({
          title: "Widget export",
          state: "open",
          html_url: "https://github.com/acme/widgets/pull/12",
          updated_at: "2026-09-01T00:00:00Z",
          pull_request: { url: "https://api.github.com/repos/acme/widgets/pulls/12" },
        });
      }
      return jsonResponse({ message: "missing" }, 404);
    });
    const provider = createGithubIssueProvider({ defaultRepo: "acme/widgets", token, fetchImpl });
    const states = await provider.fetchStates([ref("gh#12", "12")], signal);
    expect(states.get("gh#12")).toEqual({
      raw: "gh#12",
      title: "Widget export",
      state: "open",
      url: "https://github.com/acme/widgets/pull/12",
      updatedAt: "2026-09-01T00:00:00Z",
    });
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${token}`);
  });

  it("reads a closed issue", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        title: "Old defect",
        state: "closed",
        html_url: "https://github.com/acme/widgets/issues/3",
      }),
    );
    const provider = createGithubIssueProvider({ defaultRepo: "acme/widgets", token, fetchImpl });
    const states = await provider.fetchStates([ref("gh#3", "3")], signal);
    expect(states.get("gh#3")).toMatchObject({ title: "Old defect", state: "closed" });
  });

  it("returns unknown for a missing issue", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "Not Found" }, 404));
    const provider = createGithubIssueProvider({ defaultRepo: "acme/widgets", token, fetchImpl });
    const states = await provider.fetchStates([ref("gh#99", "99")], signal);
    expect(states.get("gh#99")).toEqual({
      raw: "gh#99",
      title: "",
      state: "unknown",
      url: "https://github.com/acme/widgets/issues/99",
    });
  });

  it("returns unknown when GitHub rate limits the request", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "API rate limit exceeded" }, 403));
    const provider = createGithubIssueProvider({ defaultRepo: "acme/widgets", token, fetchImpl });
    const states = await provider.fetchStates([ref("gh#4", "4")], signal);
    expect(states.get("gh#4")?.state).toBe("unknown");
    expect(JSON.stringify(states.get("gh#4"))).not.toContain(token);
  });

  it("reads a public repository when no token is configured", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        title: "Public note",
        state: "open",
        html_url: "https://github.com/acme/widgets/issues/8",
      }),
    );
    const provider = createGithubIssueProvider({ defaultRepo: "acme/widgets", fetchImpl });
    const states = await provider.fetchStates([ref("gh#8", "8")], signal);
    expect(states.get("gh#8")).toMatchObject({ title: "Public note", state: "open" });
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("authorization")).toBeNull();
  });

  it("never puts the token in errors or logs", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    const fetchImpl = vi.fn(async () => {
      throw new Error(`network down for Bearer ${token}`);
    });
    const provider = createGithubIssueProvider({ defaultRepo: "acme/widgets", token, fetchImpl });
    const states = await provider.fetchStates([ref("gh#1", "1")], signal);
    expect(states.get("gh#1")?.state).toBe("unknown");
    expect(JSON.stringify(states.get("gh#1"))).not.toContain(token);
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  it("sends the token only to the board's own repo", async () => {
    const auth = new Map<string, string | null>();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      auth.set(String(input), new Headers(init?.headers).get("authorization"));
      return jsonResponse({ title: "x", state: "open" });
    });
    const provider = createGithubIssueProvider({ defaultRepo: "Acme/Widgets", token, fetchImpl });
    await provider.fetchStates([ref("gh#1", "1"), ref("gh:other/lib#2", "other/lib#2")], signal);
    expect(auth.get("https://api.github.com/repos/Acme/Widgets/issues/1")).toBe(`Bearer ${token}`);
    expect(auth.get("https://api.github.com/repos/other/lib/issues/2")).toBeNull();
  });
});
