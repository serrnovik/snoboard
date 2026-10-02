import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSnapshot, loadConfig, type Config, type Snapshot } from "snoboard";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTmpRepo } from "../../../../packages/core/src/test-utils/tmp-repo.ts";
import { setAuthConfig, resetAuthConfig } from "../auth/env.js";
import { SESSION_COOKIE, signSession } from "../auth/session.js";
import { app } from "../index.js";
import { resetForgeCache } from "../forge/github.js";
import { resetActiveRepos, setActiveRepos, type RepoConfig } from "../repos-config.js";
import { resetStore, seedStore } from "../store.js";
import { rememberedIssueCount, resetIssueSetup } from "./setup.js";
import { ISSUE_CACHE_TTL_MS } from "./registry.js";

const sessionSecret = randomBytes(32);
const githubToken = "example-github-token";
const vikunjaToken = "example-vikunja-token";
const dirs: string[] = [];

const demoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../examples/demo-repo");

function sessionCookie(sub: string): string {
  const iat = Date.now();
  const token = signSession(sessionSecret, { sub, method: "password", iat, exp: iat + 60 * 60 * 1000 });
  return `${SESSION_COOKIE}=${token}`;
}

function authed(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set("cookie", sessionCookie("board-reader"));
  return { ...init, headers };
}

async function readTree(dir: string, prefix = ""): Promise<Record<string, string>> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: Record<string, string> = {};
  for (const entry of entries) {
    const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(files, await readTree(full, relative));
    else files[relative] = await readFile(full, "utf8");
  }
  return files;
}

async function demoSnapshot(): Promise<{ snapshot: Snapshot; config: Config }> {
  const files = await readTree(demoRoot);
  const configText = files[".snoboard.yml"];
  if (configText === undefined) throw new Error("demo repo is missing .snoboard.yml");
  const config = loadConfig(configText);
  const repo = await createTmpRepo({ commits: [{ message: "demo", files }] });
  try {
    return { snapshot: await buildSnapshot(repo.dir, config), config };
  } finally {
    await repo.remove();
  }
}

function repoConfig(id: string, issues?: RepoConfig["issues"]): RepoConfig {
  return {
    id,
    name: id,
    url: `https://example.com/${id}.git`,
    edit: { modes: [] },
    ...(issues === undefined ? {} : { issues }),
  };
}

async function writeSecret(name: string, secret: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "snoboard-issues-"));
  dirs.push(dir);
  const file = path.join(dir, name);
  await writeFile(file, `${secret}\n`, "utf8");
  return file;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type IssueBody = {
  items: Array<{ id: string; issues: Array<Record<string, unknown>> }>;
};

function reportsFrom(body: IssueBody): Array<Record<string, unknown>> {
  const reports = body.items.find((item) => item.id === "acme-003");
  if (reports === undefined) throw new Error("missing acme-003");
  return reports.issues;
}

describe("per-repo issue providers", () => {
  beforeEach(() => {
    setAuthConfig({
      modes: ["password"],
      publicUrl: "http://localhost:3000",
      sessionSecret,
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$aaaaaaaaaaaaaaaa$bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
    resetIssueSetup();
    resetStore();
    resetActiveRepos();
    resetForgeCache();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetIssueSetup();
    resetStore();
    resetActiveRepos();
    resetAuthConfig();
    resetForgeCache();
    delete process.env.SNOBOARD_GITHUB_TOKEN_FILE;
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("keeps a repository without providers off the network", async () => {
    const { snapshot, config } = await demoSnapshot();
    const tokenFile = await writeSecret("github", githubToken);
    process.env.SNOBOARD_GITHUB_TOKEN_FILE = tokenFile;
    setActiveRepos([
      repoConfig("acme", {
        github: { repo: "example/acme" },
        vikunja: { baseUrl: "https://tasks.example.com", tokenFile: await writeSecret("vikunja", vikunjaToken) },
      }),
      repoConfig("widgets"),
    ]);
    seedStore(snapshot, { ...config, forge: { ...config.forge, repo: "example/acme" } }, snapshot.generatedAt, "acme");
    seedStore(snapshot, config, snapshot.generatedAt, "widgets");
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    const started = Date.now();
    const board = await app.request("/api/repos/widgets/board", authed());
    expect(board.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reportsFrom((await board.json()) as IssueBody)).toEqual([
      { raw: "gh#12", url: "" },
      // A fully qualified GitHub ref links without any config or network call.
      { raw: "gh:acme/widgets#45", url: "https://github.com/acme/widgets/issues/45" },
      { raw: "vikunja:34", url: "" },
    ]);

    const details = await app.request("/api/repos/widgets/initiatives/acme-003", authed());
    expect(details.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    const issues = ((await details.json()) as { issues: Array<Record<string, unknown>> }).issues;
    expect(issues).toEqual([
      { raw: "gh#12", title: "", state: "unknown", url: "" },
      { raw: "gh:acme/widgets#45", title: "", state: "unknown", url: "https://github.com/acme/widgets/issues/45" },
      { raw: "vikunja:34", title: "", state: "unknown", url: "" },
    ]);
    expect(JSON.stringify(issues)).not.toContain(githubToken);
  });

  it("links Vikunja tasks without a token and never calls Vikunja", async () => {
    const { snapshot, config } = await demoSnapshot();
    setActiveRepos([repoConfig("acme", { vikunja: { baseUrl: "https://tasks.example.com" } })]);
    seedStore(snapshot, config, snapshot.generatedAt, "acme");
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    const details = await app.request("/api/repos/acme/initiatives/acme-003", authed());
    expect(details.status).toBe(200);
    const issues = ((await details.json()) as { issues: Array<Record<string, unknown>> }).issues;
    expect(issues.find((issue) => issue.raw === "vikunja:34")).toEqual({
      raw: "vikunja:34",
      title: "",
      state: "unknown",
      url: "https://tasks.example.com/tasks/34",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loads both providers, leaves a cold board on the cache, and then returns cached states", async () => {
    const { snapshot, config } = await demoSnapshot();
    const tokenFile = await writeSecret("github", githubToken);
    const vikunjaFile = await writeSecret("vikunja", vikunjaToken);
    process.env.SNOBOARD_GITHUB_TOKEN_FILE = tokenFile;
    setActiveRepos([
      repoConfig("acme", {
        github: { repo: "example/acme" },
        vikunja: { baseUrl: "https://tasks.example.com", tokenFile: vikunjaFile },
      }),
      repoConfig("widgets"),
    ]);
    seedStore(snapshot, { ...config, forge: { ...config.forge, repo: "example/acme" } }, snapshot.generatedAt, "acme");

    const calls: { url: string; auth: string | null }[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
      if (url === "https://api.github.com/repos/example/acme/issues/12") {
        return jsonResponse({
          title: "Export",
          state: "open",
          html_url: "https://github.com/example/acme/issues/12",
          updated_at: "2026-09-01T00:00:00Z",
        });
      }
      if (url === "https://api.github.com/repos/acme/widgets/issues/45") {
        return jsonResponse({
          title: "Widget",
          state: "closed",
          html_url: "https://github.com/acme/widgets/issues/45",
        });
      }
      if (url === "https://tasks.example.com/api/v1/tasks/34") {
        return jsonResponse({ id: 34, title: "Invoice", done: false, updated: "2026-09-02T00:00:00Z" });
      }
      return jsonResponse({ message: "missing" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    const cold = await app.request("/api/repos/acme/board", authed());
    expect(cold.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reportsFrom((await cold.json()) as IssueBody)).toEqual([
      { raw: "gh#12", url: "https://github.com/example/acme/issues/12" },
      { raw: "gh:acme/widgets#45", url: "https://github.com/acme/widgets/issues/45" },
      { raw: "vikunja:34", url: "https://tasks.example.com/tasks/34" },
    ]);

    const details = await app.request("/api/repos/acme/initiatives/acme-003", authed());
    expect(details.status).toBe(200);
    const issues = ((await details.json()) as { issues: Array<Record<string, unknown>> }).issues;
    expect(issues).toEqual([
      {
        raw: "gh#12",
        title: "Export",
        state: "open",
        url: "https://github.com/example/acme/issues/12",
        updatedAt: "2026-09-01T00:00:00Z",
      },
      {
        raw: "gh:acme/widgets#45",
        title: "Widget",
        state: "closed",
        url: "https://github.com/acme/widgets/issues/45",
      },
      {
        raw: "vikunja:34",
        title: "Invoice",
        state: "open",
        url: "https://tasks.example.com/tasks/34",
        updatedAt: "2026-09-02T00:00:00Z",
      },
    ]);
    expect(calls.map((call) => call.url).sort()).toEqual([
      "https://api.github.com/repos/acme/widgets/issues/45",
      "https://api.github.com/repos/example/acme/issues/12",
      "https://tasks.example.com/api/v1/tasks/34",
    ]);
    expect(calls.find((call) => call.url.endsWith("/example/acme/issues/12"))?.auth).toBe(`Bearer ${githubToken}`);
    expect(calls.find((call) => call.url.endsWith("/acme/widgets/issues/45"))?.auth).toBeNull();
    expect(calls.find((call) => call.url.includes("tasks.example.com"))?.auth).toBe(`Bearer ${vikunjaToken}`);
    expect(JSON.stringify(issues)).not.toContain(githubToken);
    expect(JSON.stringify(issues)).not.toContain(vikunjaToken);

    const warm = await app.request("/api/repos/acme/board", authed());
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(reportsFrom((await warm.json()) as IssueBody)).toEqual([
      {
        raw: "gh#12",
        url: "https://github.com/example/acme/issues/12",
        title: "Export",
        state: "open",
        updatedAt: "2026-09-01T00:00:00Z",
      },
      {
        raw: "gh:acme/widgets#45",
        url: "https://github.com/acme/widgets/issues/45",
        title: "Widget",
        state: "closed",
      },
      {
        raw: "vikunja:34",
        url: "https://tasks.example.com/tasks/34",
        title: "Invoice",
        state: "open",
        updatedAt: "2026-09-02T00:00:00Z",
      },
    ]);
  });

  it("returns unknown states when a provider fails and still serves the initiative", async () => {
    const { snapshot, config } = await demoSnapshot();
    const tokenFile = await writeSecret("github", githubToken);
    process.env.SNOBOARD_GITHUB_TOKEN_FILE = tokenFile;
    setActiveRepos([
      repoConfig("acme", {
        github: { repo: "example/acme" },
        vikunja: { baseUrl: "https://tasks.example.com", tokenFile: await writeSecret("vikunja", vikunjaToken) },
      }),
    ]);
    seedStore(snapshot, { ...config, forge: { ...config.forge, repo: "example/acme" } }, snapshot.generatedAt, "acme");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("tracker down");
      }),
    );

    const details = await app.request("/api/repos/acme/initiatives/acme-003", authed());
    expect(details.status).toBe(200);
    const body = (await details.json()) as { id: string; issues: Array<{ state: string; url: string }> };
    expect(body.id).toBe("acme-003");
    expect(body.issues.map((issue) => issue.state)).toEqual(["unknown", "unknown", "unknown"]);
    expect(body.issues.map((issue) => issue.url)).toEqual([
      "https://github.com/example/acme/issues/12",
      "https://github.com/acme/widgets/issues/45",
      "https://tasks.example.com/tasks/34",
    ]);
    expect(JSON.stringify(body)).not.toContain(githubToken);

    const board = await app.request("/api/repos/acme/board", authed());
    expect(board.status).toBe(200);
    expect(reportsFrom((await board.json()) as IssueBody).every((issue) => !("state" in issue))).toBe(true);
  });

  it("uses the forge repo and read token for a single-repo board", async () => {
    const { snapshot, config } = await demoSnapshot();
    process.env.SNOBOARD_GITHUB_TOKEN_FILE = await writeSecret("github", githubToken);
    seedStore(snapshot, config);
    const calls: { url: string; auth: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
        if (url === "https://api.github.com/repos/owner/name/issues/12") {
          return jsonResponse({ title: "Export", state: "open", html_url: "https://github.com/owner/name/issues/12" });
        }
        return jsonResponse({ message: "missing" }, 404);
      }),
    );

    const board = await app.request("/api/board", authed());
    expect(calls).toEqual([]);
    expect(reportsFrom((await board.json()) as IssueBody)).toEqual([
      { raw: "gh#12", url: "https://github.com/owner/name/issues/12" },
      { raw: "gh:acme/widgets#45", url: "https://github.com/acme/widgets/issues/45" },
      { raw: "vikunja:34", url: "" },
    ]);

    const details = await app.request("/api/initiatives/acme-003", authed());
    expect(details.status).toBe(200);
    const issues = ((await details.json()) as { issues: Array<{ raw: string; state: string }> }).issues;
    expect(issues.find((issue) => issue.raw === "gh#12")).toMatchObject({ title: "Export", state: "open" });
    expect(issues.find((issue) => issue.raw === "vikunja:34")).toMatchObject({ state: "unknown", url: "" });
    expect(calls.find((call) => call.url.endsWith("/owner/name/issues/12"))?.auth).toBe(`Bearer ${githubToken}`);
    expect(calls.find((call) => call.url.endsWith("/acme/widgets/issues/45"))?.auth).toBeNull();
    expect(calls.some((call) => call.url.includes("tasks.example.com"))).toBe(false);
    expect(JSON.stringify(issues)).not.toContain(githubToken);
  });

  it("does not send the GitHub token when the issue repo is not the forge repo", async () => {
    const { snapshot, config } = await demoSnapshot();
    process.env.SNOBOARD_GITHUB_TOKEN_FILE = await writeSecret("github", githubToken);
    setActiveRepos([repoConfig("acme", { github: { repo: "example/acme" } })]);
    seedStore(snapshot, config, snapshot.generatedAt, "acme");
    const calls: { url: string; auth: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
        return jsonResponse({ message: "missing" }, 404);
      }),
    );

    const details = await app.request("/api/repos/acme/initiatives/acme-003", authed());
    expect(details.status).toBe(200);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.auth).toBeNull();
    expect(JSON.stringify(await details.json())).not.toContain(githubToken);
  });

  it("uses a rotated token from the same token file", async () => {
    const { snapshot, config } = await demoSnapshot();
    const tokenFile = await writeSecret("github", githubToken);
    process.env.SNOBOARD_GITHUB_TOKEN_FILE = tokenFile;
    seedStore(snapshot, config);
    const auths: (string | null)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/owner/name/issues/12")) auths.push(new Headers(init?.headers).get("authorization"));
        return jsonResponse({ message: "missing" }, 404);
      }),
    );

    expect((await app.request("/api/initiatives/acme-003", authed())).status).toBe(200);
    expect(auths.at(-1)).toBe(`Bearer ${githubToken}`);

    await writeFile(tokenFile, "rotated-github-token\n", "utf8");
    expect((await app.request("/api/initiatives/acme-003", authed())).status).toBe(200);
    expect(auths.at(-1)).toBe("Bearer rotated-github-token");
  });

  it("evicts expired issue states", async () => {
    const { snapshot, config } = await demoSnapshot();
    process.env.SNOBOARD_GITHUB_TOKEN_FILE = await writeSecret("github", githubToken);
    seedStore(snapshot, config);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ title: "Export", state: "open", html_url: "https://github.com/owner/name/issues/12" })),
    );

    expect((await app.request("/api/initiatives/acme-003", authed())).status).toBe(200);
    expect(rememberedIssueCount()).toBeGreaterThan(0);

    const later = Date.now() + ISSUE_CACHE_TTL_MS + 1;
    vi.spyOn(Date, "now").mockReturnValue(later);
    const board = await app.request("/api/board", authed());
    expect(reportsFrom((await board.json()) as IssueBody).every((issue) => !("state" in issue))).toBe(true);
    expect(rememberedIssueCount()).toBe(0);
  });
});
