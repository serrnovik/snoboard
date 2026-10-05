import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allowIssueCreate, ISSUE_CREATE_LIMIT_PER_HOUR, parseIssueCreateBody, resetIssueCreateLimits } from "./create.js";
import { scrubTokens, snoboardFooter } from "./create-common.js";
import { createForgejoProvider } from "./forgejo.js";
import { createGithubIssueProvider } from "./github.js";
import { IssueCreateError, type NewIssue } from "./provider.js";
import { createVikunjaProvider } from "./vikunja.js";

const signal = new AbortController().signal;
const dirs: string[] = [];
const issue: NewIssue = { title: "Ship it", body: "Details", createdBy: "ada@example.com", initiativeId: "acme-001" };

function tokenFile(token: string): string {
  const dir = mkdtempSync(join(tmpdir(), "snoboard-create-"));
  dirs.push(dir);
  const file = join(dir, "token");
  writeFileSync(file, `${token}\n`, "utf8");
  return file;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type Call = { url: string; init: RequestInit };

function recorder(response: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response();
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

async function failure(promise: Promise<unknown>): Promise<IssueCreateError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof IssueCreateError) return error;
    throw error;
  }
  throw new Error("expected a failure");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  resetIssueCreateLimits();
});

describe("GitHub createIssue", () => {
  it("posts as the person with their own token, not the read token", async () => {
    const { calls, fetchImpl } = recorder(() =>
      jsonResponse({ number: 42, html_url: "https://github.com/acme/widgets/issues/42" }, 201),
    );
    const provider = createGithubIssueProvider({ defaultRepo: "acme/widgets", token: "board-read-token", fetchImpl });
    const created = await provider.createIssue?.({ ...issue, labels: ["snoboard"] }, { token: "user-write-token" }, signal);
    expect(created).toEqual({ ref: "gh#42", url: "https://github.com/acme/widgets/issues/42" });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://api.github.com/repos/acme/widgets/issues");
    expect(call.init.method).toBe("POST");
    expect(call.init.redirect).toBe("error");
    const headers = new Headers(call.init.headers);
    expect(headers.get("authorization")).toBe("Bearer user-write-token");
    expect(headers.get("accept")).toBe("application/vnd.github+json");
    expect(JSON.parse(String(call.init.body))).toEqual({ title: "Ship it", body: "Details", labels: ["snoboard"] });
  });

  it("refuses without a user token and never calls GitHub", async () => {
    const { fetchImpl } = recorder(() => jsonResponse({}));
    const provider = createGithubIssueProvider({ defaultRepo: "acme/widgets", token: "board-read-token", fetchImpl });
    const error = await failure(provider.createIssue!(issue, {}, signal));
    expect(error.code).toBe("auth");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps errors and scrubs the token from GitHub's message", async () => {
    const userToken = "user-write-token-123";
    const cases: [number, string][] = [
      [401, "auth"],
      [403, "scope"],
      [404, "not_found"],
      [422, "rejected"],
      [500, "upstream"],
    ];
    for (const [status, code] of cases) {
      const { fetchImpl } = recorder(() => jsonResponse({ message: `bad ${userToken} value` }, status));
      const provider = createGithubIssueProvider({ defaultRepo: "acme/widgets", fetchImpl });
      const error = await failure(provider.createIssue!(issue, { token: userToken }, signal));
      expect(error.code, String(status)).toBe(code);
      expect(error.message).not.toContain(userToken);
    }
  });

  it("does not trust a foreign html_url and fails on a missing number", async () => {
    const foreign = recorder(() => jsonResponse({ number: 7, html_url: "https://evil.example.com/x" }, 201));
    const provider = createGithubIssueProvider({ defaultRepo: "acme/widgets", fetchImpl: foreign.fetchImpl });
    expect(await provider.createIssue!(issue, { token: "user-write-token" }, signal)).toEqual({
      ref: "gh#7",
      url: "https://github.com/acme/widgets/issues/7",
    });
    const empty = recorder(() => jsonResponse({}, 201));
    const broken = createGithubIssueProvider({ defaultRepo: "acme/widgets", fetchImpl: empty.fetchImpl });
    expect((await failure(broken.createIssue!(issue, { token: "user-write-token" }, signal))).code).toBe("upstream");
  });

  it("hides transport error text (redirects are refused by fetch)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("redirect to https://user-write-token@evil.example.com");
    }) as unknown as typeof fetch;
    const provider = createGithubIssueProvider({ defaultRepo: "acme/widgets", fetchImpl });
    const error = await failure(provider.createIssue!(issue, { token: "user-write-token" }, signal));
    expect(error.code).toBe("upstream");
    expect(error.message).toBe("could not reach GitHub");
  });
});

describe("Forgejo createIssue", () => {
  const base = "https://forge.example.com";

  it("is only offered with a readable token", () => {
    expect(createForgejoProvider({ baseUrl: base, repo: "acme/widgets" }).createIssue).toBeUndefined();
    expect(createForgejoProvider({ baseUrl: base, repo: "acme/widgets", tokenFile: tokenFile("fj-token-1") }).createIssue).toBeDefined();
  });

  it("posts to the configured base with the board token and a footer", async () => {
    const { calls, fetchImpl } = recorder(() =>
      jsonResponse({ number: 9, html_url: `${base}/acme/widgets/issues/9` }, 201),
    );
    const provider = createForgejoProvider({ baseUrl: `${base}/`, repo: "acme/widgets", tokenFile: tokenFile("fj-token-1"), fetchImpl });
    const created = await provider.createIssue!(issue, { token: "ignored-user-token" }, signal);
    expect(created).toEqual({ ref: "fj#9", url: `${base}/acme/widgets/issues/9` });
    const call = calls[0]!;
    expect(call.url).toBe(`${base}/api/v1/repos/acme/widgets/issues`);
    expect(call.init.method).toBe("POST");
    expect(call.init.redirect).toBe("error");
    expect(new Headers(call.init.headers).get("authorization")).toBe("token fj-token-1");
    expect(JSON.parse(String(call.init.body))).toEqual({
      title: "Ship it",
      body: "Details\n\n---\nCreated from Snoboard by ada@example.com for acme-001",
    });
  });

  it("says the token lacks issue write scope on 403 and scrubs it", async () => {
    const { fetchImpl } = recorder(() => jsonResponse({ message: "token fj-token-1 is missing write:issue" }, 403));
    const provider = createForgejoProvider({ baseUrl: base, repo: "acme/widgets", tokenFile: tokenFile("fj-token-1"), fetchImpl });
    const error = await failure(provider.createIssue!(issue, {}, signal));
    expect(error.code).toBe("scope");
    expect(error.message).toContain("lacks issue write scope");
    expect(error.message).not.toContain("fj-token-1");

    const rejected = recorder(() => jsonResponse({ message: "bad fj-token-1" }, 422));
    const other = createForgejoProvider({ baseUrl: base, repo: "acme/widgets", tokenFile: tokenFile("fj-token-1"), fetchImpl: rejected.fetchImpl });
    const refused = await failure(other.createIssue!(issue, {}, signal));
    expect(refused.code).toBe("rejected");
    expect(refused.message).toBe("Forgejo refused the issue: bad [redacted]");
  });

  it("keeps a link only on the configured base", async () => {
    const { fetchImpl } = recorder(() => jsonResponse({ number: 3, html_url: "https://evil.example.com/acme/widgets/issues/3" }, 201));
    const provider = createForgejoProvider({ baseUrl: base, repo: "acme/widgets", tokenFile: tokenFile("fj-token-1"), fetchImpl });
    expect((await provider.createIssue!(issue, {}, signal)).url).toBe(`${base}/acme/widgets/issues/3`);
  });
});

describe("Vikunja createIssue", () => {
  const base = "https://tasks.example.com";

  it("needs both a token and a project id", () => {
    expect(createVikunjaProvider({ baseUrl: base, tokenFile: tokenFile("vj-token-1") }).createIssue).toBeUndefined();
    expect(createVikunjaProvider({ baseUrl: base, projectId: 4 }).createIssue).toBeUndefined();
    expect(createVikunjaProvider({ baseUrl: base, projectId: 4, tokenFile: tokenFile("vj-token-1") }).createIssue).toBeDefined();
  });

  it("puts a task into the project with a footer and returns vj:<id>", async () => {
    const { calls, fetchImpl } = recorder(() => jsonResponse({ id: 77, title: "Ship it" }, 201));
    const provider = createVikunjaProvider({ baseUrl: base, projectId: 4, tokenFile: tokenFile("vj-token-1"), fetchImpl });
    expect(await provider.createIssue!(issue, {}, signal)).toEqual({ ref: "vj:77", url: `${base}/tasks/77` });
    const call = calls[0]!;
    expect(call.url).toBe(`${base}/api/v1/projects/4/tasks`);
    expect(call.init.method).toBe("PUT");
    expect(call.init.redirect).toBe("error");
    expect(new Headers(call.init.headers).get("authorization")).toBe("Bearer vj-token-1");
    expect(JSON.parse(String(call.init.body))).toEqual({
      title: "Ship it",
      description: "Details\n\n---\nCreated from Snoboard by ada@example.com for acme-001",
    });
  });

  it("creates with a project map only, into the requested project", async () => {
    const { calls, fetchImpl } = recorder(() => jsonResponse({ id: 8 }, 201));
    const provider = createVikunjaProvider({ baseUrl: base, projectMap: { app: 23 }, tokenFile: tokenFile("vj-token-1"), fetchImpl });
    expect(provider.listProjects).toBeDefined();
    await provider.createIssue!({ ...issue, projectId: 23 }, {}, signal);
    expect(calls[0]?.url).toBe(`${base}/api/v1/projects/23/tasks`);
  });

  it("lists projects as id and title only, skipping archived ones", async () => {
    const { calls, fetchImpl } = recorder(() =>
      jsonResponse([
        { id: 9, title: "Productivity", owner: { email: "x@example.com" } },
        { id: 10, title: "Old", is_archived: true },
        { id: 11, title: "leak vj-token-1" },
        { id: "bad", title: "Nope" },
      ]),
    );
    const provider = createVikunjaProvider({ baseUrl: base, projectId: 9, tokenFile: tokenFile("vj-token-1"), fetchImpl });
    const projects = await provider.listProjects!(signal);
    expect(projects).toEqual([
      { id: 9, title: "Productivity" },
      { id: 11, title: "Project 11" },
    ]);
    expect(calls[0]?.url).toBe(`${base}/api/v1/projects?per_page=200`);
    expect(calls[0]?.init.redirect).toBe("error");
  });

  it("maps a 403 and scrubs the token", async () => {
    const { fetchImpl } = recorder(() => jsonResponse({ message: "vj-token-1 forbidden" }, 403));
    const provider = createVikunjaProvider({ baseUrl: base, projectId: 4, tokenFile: tokenFile("vj-token-1"), fetchImpl });
    const error = await failure(provider.createIssue!(issue, {}, signal));
    expect(error.code).toBe("scope");
    expect(error.message).not.toContain("vj-token-1");
  });
});

describe("issue creation helpers", () => {
  it("scrubs tokens and control characters", () => {
    expect(scrubTokens("a secret-token\nb secret-token", ["secret-token"])).toBe("a [redacted] b [redacted]");
    expect(scrubTokens("x".repeat(300), []).length).toBeLessThanOrEqual(201);
  });

  it("appends a footer", () => {
    expect(snoboardFooter("", "ada", "acme-001")).toBe("Created from Snoboard by ada for acme-001");
    expect(snoboardFooter("Text\n\n", "ada\nfake", "acme-001")).toBe(
      "Text\n\n---\nCreated from Snoboard by ada fake for acme-001",
    );
  });

  it("validates the request body", () => {
    const ok = { provider: "fj", initiativeId: "acme-001", title: "  T  ", body: "B", csrf: "c" };
    expect(parseIssueCreateBody(JSON.stringify(ok))).toEqual({ ...ok, title: "T" });
    expect(parseIssueCreateBody("{")).toEqual({ error: "invalid json" });
    expect(parseIssueCreateBody(JSON.stringify({ ...ok, provider: "jira" }))).toEqual({ error: "unknown provider" });
    expect(parseIssueCreateBody(JSON.stringify({ ...ok, title: " " }))).toEqual({ error: "title is required" });
    expect(parseIssueCreateBody(JSON.stringify({ ...ok, title: "x".repeat(257) }))).toHaveProperty("error");
    expect(parseIssueCreateBody(JSON.stringify({ ...ok, title: "a\nb" }))).toEqual({ error: "title must be one line" });
    expect(parseIssueCreateBody(JSON.stringify({ ...ok, title: "x".repeat(256) }))).not.toHaveProperty("error");
    expect(parseIssueCreateBody(JSON.stringify({ ...ok, body: "x".repeat(20_001) }))).toHaveProperty("error");
    expect(parseIssueCreateBody(JSON.stringify({ ...ok, initiativeId: "../x" }))).toEqual({ error: "invalid initiative id" });
  });

  it("limits creations per person per hour", () => {
    const now = 1_000_000;
    for (let index = 0; index < ISSUE_CREATE_LIMIT_PER_HOUR; index += 1) expect(allowIssueCreate("p", now)).toBe(true);
    expect(allowIssueCreate("p", now)).toBe(false);
    expect(allowIssueCreate("q", now)).toBe(true);
    expect(allowIssueCreate("p", now + 60 * 60 * 1000)).toBe(true);
  });
});
