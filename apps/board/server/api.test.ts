import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { bodyHash, buildGraph, buildSnapshot, loadConfig, type Config, type Snapshot } from "snoboard";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTmpRepo } from "../../../packages/core/src/test-utils/tmp-repo.ts";
import { githubRepoFromUrl, resetRefreshLimits } from "./api.js";
import { setInitiativeRepoDir } from "./repo-sync.js";
import { resetEditConfig, setEditConfig } from "./edit-env.js";
import { resetActiveRepos, setActiveRepos, type RepoConfig } from "./repos-config.js";
import { resetAuthConfig, setAuthConfig } from "./auth/env.js";
import { resetForgeCache } from "./forge/github.js";
import { SESSION_COOKIE, signSession } from "./auth/session.js";
import { app } from "./index.js";
import { resetHistoryCaches } from "./history.js";
import { recordSyncError, resetStore, seedStore } from "./store.js";

const refresh = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("./repo-sync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./repo-sync.js")>();
  return {
    ...actual,
    requestRefresh: refresh,
  };
});

const sessionSecret = randomBytes(32);

function sessionCookie(sub: string, iat = Date.now()): string {
  const token = signSession(sessionSecret, {
    sub,
    method: "password",
    iat,
    exp: iat + 60 * 60 * 1000,
  });
  return `${SESSION_COOKIE}=${token}`;
}

function authed(sub = "board-reader", init?: RequestInit, iat = Date.now()): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set("cookie", sessionCookie(sub, iat));
  return { ...init, headers };
}

const demoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../examples/demo-repo",
);

async function readTree(dir: string, prefix = ""): Promise<Record<string, string>> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: Record<string, string> = {};
  for (const entry of entries) {
    const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(files, await readTree(full, relative));
    } else {
      files[relative] = await readFile(full, "utf8");
    }
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
    const snapshot = await buildSnapshot(repo.dir, config);
    return { snapshot, config };
  } finally {
    await repo.remove();
  }
}

describe("read-only API", () => {
  beforeEach(() => {
    setAuthConfig({
      modes: ["password"],
      publicUrl: "http://localhost:3000",
      sessionSecret,
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$aaaaaaaaaaaaaaaa$bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
  });

  afterEach(() => {
    resetStore();
    resetAuthConfig();
    resetEditConfig();
    resetActiveRepos();
    resetRefreshLimits();
    resetForgeCache();
    resetHistoryCaches();
    setInitiativeRepoDir(undefined);
    delete process.env.SNOBOARD_GITHUB_TOKEN_FILE;
    refresh.mockClear();
  });

  it("returns 503 before a snapshot exists", async () => {
    resetStore();
    const response = await app.request("/api/board", authed());
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("serves the demo snapshot, initiative details, and refresh limits", async () => {
    const { snapshot, config } = await demoSnapshot();
    seedStore(snapshot, config);

    const board = await app.request("/api/board", authed());
    expect(board.status).toBe(200);
    expect(board.headers.get("cache-control")).toBe("no-store");
    const body = (await board.json()) as {
      status: { refreshing: boolean; lastError: string | null };
      config: { statuses: string[]; priorities: string[]; doneStatuses: string[]; staleAfterDays: number };
      items: Array<{ id: string }>;
      legacy: Array<{ path: string }>;
      errors: Array<{ path: string }>;
      refs: Array<{ name: string }>;
    };
    expect(Object.keys(body).sort()).toEqual(
      ["config", "errors", "items", "legacy", "people", "proposals", "refs", "status"].sort(),
    );
    expect((body as { proposals: unknown }).proposals).toEqual([]);
    expect(body.config).toEqual({
      statuses: config.statuses,
      priorities: config.priorities,
      doneStatuses: config.doneStatuses,
      staleAfterDays: config.staleAfterDays,
    });
    expect(body.items.map((item) => item.id).sort()).toEqual(["acme-001", "acme-002", "acme-003"]);
    expect(body.legacy.some((item) => item.path.includes("platform/001-ci"))).toBe(true);
    expect(body.errors.some((item) => item.path.includes("platform/002-broken"))).toBe(true);
    expect(body.refs.some((ref) => ref.name === "main")).toBe(true);
    expect(body.status.refreshing).toBe(false);

    const reports = await app.request("/api/initiatives/acme-003", authed());
    expect(reports.status).toBe(200);
    expect(reports.headers.get("cache-control")).toBe("no-store");
    const reportsBody = (await reports.json()) as {
      id: string;
      blockedChain: string[];
      dependents: string[];
      forge: { type: string; repo: string; fileUrl: string; prUrl: string };
      prs?: unknown;
    };
    expect(reportsBody.id).toBe("acme-003");
    expect(reportsBody.blockedChain).toEqual(["acme-002"]);
    expect(reportsBody.dependents).toEqual([]);
    expect(reportsBody.forge).toEqual({
      type: "github",
      repo: "owner/name",
      fileUrl: "https://github.com/{repo}/blob/{ref}/{path}",
      prUrl: "https://github.com/{repo}/pull/{pr}",
    });
    expect(reportsBody.prs).toBeUndefined();

    const billing = await app.request("/api/initiatives/acme-002", authed());
    const billingBody = (await billing.json()) as { dependents: string[]; blockedChain: string[] };
    expect(billingBody.dependents).toContain("acme-003");
    expect(billingBody.blockedChain).toEqual([]);

    const missing = await app.request("/api/initiatives/acme-999", authed());
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");

    const now = Date.now();
    const first = await app.request(
      "/api/refresh",
      authed("alpha", { method: "POST" }, now - 10_000),
    );
    expect(first.status).toBe(202);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const limited = await app.request(
      "/api/refresh",
      authed("alpha", { method: "POST" }, now - 5_000),
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("cache-control")).toBe("no-store");
    const otherSession = await app.request(
      "/api/refresh",
      authed("beta", { method: "POST" }, now - 10_000),
    );
    expect(otherSession.status).toBe(202);
    expect(refresh).toHaveBeenCalledTimes(2);

    for (const method of ["PUT", "PATCH", "DELETE"] as const) {
      const response = await app.request("/api/board", authed("board-reader", { method }));
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    const postBoard = await app.request("/api/board", authed("board-reader", { method: "POST" }));
    expect(postBoard.status).toBe(404);
    const postMissing = await app.request(
      "/api/initiatives/acme-001",
      authed("board-reader", { method: "POST" }),
    );
    expect(postMissing.status).toBe(404);
  }, 30_000);

  it("counts a phase dependency as a dependent of that initiative", async () => {
    const { snapshot, config } = await demoSnapshot();
    const billing = snapshot.items.find((item) => item.id === "acme-002");
    if (billing === undefined) throw new Error("missing acme-002");
    billing.depends_on = ["acme-001#2"];
    const graph = buildGraph(
      snapshot.items.map((item) => ({
        id: item.id,
        status: item.status,
        depends_on: [...item.depends_on],
        ...(item.phases === undefined ? {} : { phases: item.phases }),
      })),
      config,
    );
    snapshot.graph = {
      ...graph,
      edges: [...graph.edges, { from: "acme-001#2", to: "acme-002" }, { from: "acme-001", to: "acme-002#9" }],
    };
    seedStore(snapshot, config);

    const response = await app.request("/api/initiatives/acme-001", authed());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { dependents: string[] };
    expect(body.dependents).toEqual(["acme-002"]);
  });

  it("exposes cached pull request state when a GitHub token file is set", async () => {
    const { snapshot, config } = await demoSnapshot();
    const onboarding = snapshot.items.find((item) => item.id === "acme-001");
    if (onboarding === undefined) throw new Error("missing acme-001");
    onboarding.phases = [
      ...(onboarding.phases ?? []),
      { id: 9, title: "Ship", status: "done", pr: 12 },
    ];
    seedStore(snapshot, config);
    const dir = await mkdtemp(path.join(os.tmpdir(), "snoboard-token-"));
    const tokenFile = path.join(dir, "github-token");
    await writeFile(tokenFile, "test-token", "utf8");
    process.env.SNOBOARD_GITHUB_TOKEN_FILE = tokenFile;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://api.github.com/repos/owner/name/pulls/12") {
        return new Response(JSON.stringify({ state: "closed", merged: true, head: { sha: "abc1234" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "https://api.github.com/repos/owner/name/commits/abc1234/status") {
        return new Response(JSON.stringify({ state: "success" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("missing", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const response = await app.request("/api/initiatives/acme-001", authed());
      expect(response.status).toBe(200);
      const body = (await response.json()) as { prs: Record<string, { state: string; merged: boolean; checks: string }> };
      expect(body.prs["12"]).toEqual({ state: "closed", merged: true, checks: "success" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const again = await app.request("/api/initiatives/acme-001", authed());
      expect(again.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      delete process.env.SNOBOARD_GITHUB_TOKEN_FILE;
      vi.unstubAllGlobals();
      resetForgeCache();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("serves default-branch history and per-initiative people, cached per snapshot", async () => {
    const files = await readTree(demoRoot);
    const configText = files[".snoboard.yml"];
    if (configText === undefined) throw new Error("demo repo is missing .snoboard.yml");
    const config = loadConfig(configText);
    const target = "initiatives/acme/001-onboarding/initiative.md";
    const repo = await createTmpRepo({
      commits: [
        { message: "demo", date: "2024-01-01T00:00:00Z", files },
        {
          message: "board edit\n\nSnoboard-Edit-By: octo (board)\nCo-Authored-By: Claude <noreply@anthropic.com>",
          date: "2024-01-02T00:00:00Z",
          files: { [target]: `${files[target] ?? ""}\n` },
        },
      ],
    });
    try {
      seedStore(await buildSnapshot(repo.dir, config), config);
      setInitiativeRepoDir(repo.dir);
      const response = await app.request("/api/initiatives/acme-001/history", authed());
      expect(response.status).toBe(200);
      const history = (await response.json()) as { commits: { sha: string; subject: string; author: string }[]; hasMore: boolean };
      expect(history.commits.map((commit) => commit.subject)).toEqual(["board edit", "demo"]);
      expect(history.hasMore).toBe(false);
      expect((await app.request("/api/initiatives/acme-001/history?skip=-1", authed())).status).toBe(400);
      expect((await app.request("/api/initiatives/acme-999/history", authed())).status).toBe(404);
      expect((await app.request("/api/initiatives/acme-001/history")).status).toBe(401);

      const board = (await (await app.request("/api/board", authed())).json()) as {
        people: Record<string, { creator: { name: string } | null; participants: { name: string; login?: string }[] }>;
      };
      const people = board.people["acme-001"];
      expect(people?.participants.map((person) => person.login ?? null)).toContain("octo");
      expect(people?.participants.some((person) => /claude/i.test(person.name))).toBe(false);
      expect(people?.creator).not.toBeNull();
    } finally {
      setInitiativeRepoDir(undefined);
      await repo.remove();
    }
  });

  it("returns the initiative body and its hash", async () => {
    const files = await readTree(demoRoot);
    const configText = files[".snoboard.yml"];
    if (configText === undefined) throw new Error("demo repo is missing .snoboard.yml");
    const config = loadConfig(configText);
    const repo = await createTmpRepo({ commits: [{ message: "demo", files }] });
    try {
      seedStore(await buildSnapshot(repo.dir, config), config);
      const unavailable = await app.request("/api/initiatives/acme-001/body", authed());
      expect(unavailable.status).toBe(503);

      setInitiativeRepoDir(repo.dir);
      const response = await app.request("/api/initiatives/acme-001/body", authed());
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const payload = (await response.json()) as { body: string; hash: string };
      const raw = files["initiatives/acme/001-onboarding/initiative.md"];
      if (raw === undefined) throw new Error("missing demo initiative");
      expect(Object.keys(payload).sort()).toEqual(["body", "hash"]);
      expect(payload.hash).toBe(bodyHash(raw));
      expect(payload.hash).toBe(createHash("sha256").update(payload.body, "utf8").digest("hex"));
      expect(payload.body.startsWith("\n# Customer onboarding\n")).toBe(true);
      expect(payload.body).not.toContain("id: acme-001");

      const missing = await app.request("/api/initiatives/acme-999/body", authed());
      expect(missing.status).toBe(404);
      const anonymous = await app.request("/api/initiatives/acme-001/body");
      expect(anonymous.status).toBe(401);
    } finally {
      setInitiativeRepoDir(undefined);
      await repo.remove();
    }
  });
  it("serves committed images with safe headers, and nothing else", async () => {
    const files = await readTree(demoRoot);
    const configText = files[".snoboard.yml"];
    if (configText === undefined) throw new Error("demo repo is missing .snoboard.yml");
    const config = loadConfig(configText);
    const folder = "initiatives/acme/001-onboarding";
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]), Buffer.from("pixels")]);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const repo = await createTmpRepo({
      commits: [
        {
          message: "demo",
          files: {
            ...files,
            [`${folder}/assets/shot.png`]: png,
            [`${folder}/assets/fake.png`]: svg,
            [`${folder}/assets/logo.svg`]: svg,
            [`${folder}/secret.png`]: png,
            "initiatives/acme/assets/other.png": png,
          },
        },
      ],
    });
    try {
      seedStore(await buildSnapshot(repo.dir, config), config);
      setInitiativeRepoDir(repo.dir);
      const response = await app.request("/api/initiatives/acme-001/assets/shot.png", authed());
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-security-policy")).toBe("default-src 'none'");
      expect(Buffer.from(await response.arrayBuffer()).equals(png)).toBe(true);
      const scoped = await app.request("/api/repos/default/initiatives/acme-001/assets/shot.png", authed());
      expect(scoped.status).toBe(200);

      const anonymous = await app.request("/api/initiatives/acme-001/assets/shot.png");
      expect(anonymous.status).toBe(401);

      for (const route of [
        "/api/initiatives/acme-001/assets/fake.png",
        "/api/initiatives/acme-001/assets/logo.svg",
        "/api/initiatives/acme-001/assets/missing.png",
        "/api/initiatives/acme-001/assets/..%2Fsecret.png",
        "/api/initiatives/acme-001/assets/..%2F..%2Fassets%2Fother.png",
        "/api/initiatives/acme-001/assets/%2e%2e%2fsecret.png",
        "/api/initiatives/acme-001/assets/Shot.PNG",
        "/api/initiatives/acme-999/assets/shot.png",
        "/api/repos/nope/initiatives/acme-001/assets/shot.png",
      ]) {
        const refused = await app.request(route, authed());
        expect(refused.status, route).toBe(404);
        expect(refused.headers.get("content-type") ?? "", route).not.toContain("image/");
      }
      const traversal = await app.request("/api/initiatives/acme-001/assets/../secret.png", authed());
      expect(traversal.status).toBe(404);
    } finally {
      setInitiativeRepoDir(undefined);
      await repo.remove();
    }
  });

  it("rejects unauthenticated, oversized, and oversized edit batches", async () => {
    const anonymous = await app.request("/api/edits/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ edits: [] }),
    });
    expect(anonymous.status).toBe(401);

    const oversized = await app.request(
      "/api/edits/validate",
      authed("board-reader", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ edits: [], pad: "a".repeat(70_000) }),
      }),
    );
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ error: "payload too large" });

    const underTheEditLimit = await app.request(
      "/api/edits/validate",
      authed("board-reader", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ edits: [], pad: "a".repeat(20_000) }),
      }),
    );
    expect(underTheEditLimit.status).toBe(503);

    const tooMany = Array.from({ length: 51 }, () => ({
      kind: "setStatus",
      id: "acme-001",
      from: "idea",
      to: "planned",
    }));
    const rejected = await app.request(
      "/api/edits/validate",
      authed("board-reader", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ edits: tooMany }),
      }),
    );
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ error: "too many edits" });
    expect(rejected.headers.get("cache-control")).toBe("no-store");
  });

  it("previews edits for a read-only identity and does not write the checkout", async () => {
    setEditConfig({ enabled: true, modes: ["pr"], botTokenConfigured: false });
    const permissions = await app.request("/api/edit-config", authed());
    expect(permissions.status).toBe(200);
    expect(await permissions.json()).toMatchObject({ canSubmit: false, needsGithubWrite: false });

    const source = `---
id: acme-001
title: Alpha
status: idea
priority: p2
updated: 2026-09-01
---

# Alpha

## Summary

Keep.
`;
    const repo = await createTmpRepo({
      commits: [{ message: "main", files: { "initiatives/acme/001-alpha/initiative.md": source } }],
    });
    const git = promisify(execFile);
    try {
      const snapshot = await buildSnapshot(repo.dir, loadConfig());
      seedStore(snapshot, loadConfig());
      setInitiativeRepoDir(repo.dir);
      const head = (await git("git", ["--no-pager", "rev-parse", "HEAD"], { cwd: repo.dir })).stdout.trim();
      const status = (await git("git", ["--no-pager", "status", "--porcelain"], { cwd: repo.dir })).stdout;

      const response = await app.request(
        "/api/edits/validate",
        authed("board-reader", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            edits: [
              { kind: "setStatus", id: "acme-001", from: "idea", to: "review" },
              { kind: "setStatus", id: "acme-001", from: "idea", to: "planned" },
            ],
          }),
        }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = (await response.json()) as {
        results: { index: number; ok: boolean; error?: string }[];
        files: { path: string; baseSha: string | null }[];
      };
      expect(body.results[0]).toMatchObject({ index: 0, ok: true });
      expect(body.results[1]).toEqual({
        index: 1,
        ok: false,
        error: "acme-001: stale",
        path: "initiatives/acme/001-alpha/initiative.md",
      });
      expect(body.files).toEqual([]);
      expect(JSON.stringify(body)).not.toContain(source.slice(0, 20));

      const valid = await app.request(
        "/api/edits/validate",
        authed("board-reader", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            edits: [{ kind: "setStatus", id: "acme-001", from: "idea", to: "review" }],
          }),
        }),
      );
      expect(valid.status).toBe(200);
      const validBody = (await valid.json()) as {
        results: { ok: boolean }[];
        files: { path: string; baseSha: string }[];
      };
      expect(validBody.results).toEqual([
        { index: 0, ok: true, path: "initiatives/acme/001-alpha/initiative.md" },
      ]);
      expect(validBody.files).toHaveLength(1);
      expect(validBody.files[0]?.path).toBe("initiatives/acme/001-alpha/initiative.md");
      const blob = (await git("git", ["--no-pager", "rev-parse", "HEAD:initiatives/acme/001-alpha/initiative.md"], { cwd: repo.dir })).stdout.trim();
      expect(validBody.files[0]?.baseSha).toBe(blob);
      expect((await git("git", ["--no-pager", "rev-parse", "HEAD"], { cwd: repo.dir })).stdout.trim()).toBe(head);
      expect((await git("git", ["--no-pager", "status", "--porcelain"], { cwd: repo.dir })).stdout).toBe(status);
    } finally {
        await repo.remove();
    }
  }, 30_000);
});

describe("repo-namespaced API", () => {
  const dirs: string[] = [];

  beforeEach(() => {
    setAuthConfig({
      modes: ["password"],
      publicUrl: "http://localhost:3000",
      sessionSecret,
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$aaaaaaaaaaaaaaaa$bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
  });

  afterEach(async () => {
    resetStore();
    resetAuthConfig();
    resetEditConfig();
    resetActiveRepos();
    resetRefreshLimits();
    resetForgeCache();
    setInitiativeRepoDir(undefined);
    delete process.env.SNOBOARD_GITHUB_TOKEN_FILE;
    refresh.mockClear();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("returns the stored sync error, not warmup, for a repo whose first sync failed", async () => {
    publishRepos();
    const warming = await app.request("/api/repos/acme/board", authed());
    expect(warming.status).toBe(503);
    expect(await warming.json()).toEqual({ error: "snapshot not ready" });

    recordSyncError("clone failed: bad url", "2026-10-01T00:01:00.000Z", "acme");
    for (const route of ["/api/repos/acme/board", "/api/repos/acme/initiatives/acme-001", "/api/repos/acme/initiatives/acme-001/body"]) {
      const failed = await app.request(route, authed());
      expect(failed.status).toBe(503);
      const body = (await failed.json()) as { error: string; code: string };
      expect(body.code).toBe("sync_failed");
      expect(body.error).toContain("clone failed: bad url");
      expect(body.error).not.toBe("snapshot not ready");
    }
  });

  function publishRepos(botTokenFile?: string): void {
    setActiveRepos([
      repoConfig("acme", "Acme platform", { modes: ["pr"], baseBranch: "develop" }),
      repoConfig("widgets", "Widgets", {
        modes: ["direct"],
        directBranch: "live",
        ...(botTokenFile === undefined ? {} : { botTokenFile }),
      }),
    ]);
  }

  it("exposes the repo's issue link config without tokens", async () => {
    setActiveRepos([
      {
        ...repoConfig("acme", "Acme platform", { modes: ["pr"] }),
        issues: {
          github: { repo: "example/acme" },
          vikunja: { baseUrl: "https://tasks.example.com/", tokenFile: "/secrets/vikunja-token" },
        },
      },
      repoConfig("widgets", "Widgets", { modes: ["pr"] }),
    ]);
    const acme = (await (await app.request("/api/repos/acme/edit-config", authed())).json()) as { issues: unknown };
    expect(acme.issues).toEqual({ vikunjaBaseUrl: "https://tasks.example.com", githubRepo: "example/acme" });
    expect(JSON.stringify(acme)).not.toContain("vikunja-token");
    const widgets = (await (await app.request("/api/repos/widgets/edit-config", authed())).json()) as { issues: unknown };
    expect(widgets.issues).toEqual({});
  });

  it("lists the implicit default repository when no catalog is published", async () => {
    const response = await app.request("/api/repos", authed());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual([
      {
        id: "default",
        name: "default",
        status: { lastFetchAt: null, lastError: null, lastErrorAt: null, refreshing: false },
      },
    ]);
  });

  it("serves each namespaced route, rejects an unknown repo, and aliases the first repo", async () => {
    const { snapshot, config } = await demoSnapshot();
    seedStore(snapshot, config, "2026-10-01T00:00:00.000Z", "widgets");
    recordSyncError("widgets failed", "2026-10-01T00:01:00.000Z", "widgets");
    const botTokenFile = await writeSecret("repo-bot-secret");
    dirs.push(path.dirname(botTokenFile));
    publishRepos(botTokenFile);
    setEditConfig({ enabled: false, modes: [], botTokenConfigured: false });

    const listed = await app.request("/api/repos", authed());
    expect(await listed.json()).toEqual([
      {
        id: "acme",
        name: "Acme platform",
        status: { lastFetchAt: null, lastError: null, lastErrorAt: null, refreshing: false },
      },
      {
        id: "widgets",
        name: "Widgets",
        status: {
          lastFetchAt: "2026-10-01T00:00:00.000Z",
          lastError: "widgets failed",
          lastErrorAt: "2026-10-01T00:01:00.000Z",
          refreshing: false,
        },
      },
    ]);

    const missingAcme = await app.request("/api/repos/acme/board", authed());
    expect(missingAcme.status).toBe(503);
    const aliasBoard = await app.request("/api/board", authed());
    expect(aliasBoard.status).toBe(503);

    seedStore(snapshot, config, "2026-10-01T00:02:00.000Z", "acme");
    const acmeBoard = await app.request("/api/repos/acme/board", authed());
    expect(acmeBoard.status).toBe(200);
    const acmeBody = (await acmeBoard.json()) as { items: { id: string }[]; status: { lastError: string | null } };
    expect(acmeBody.items.map((item) => item.id).sort()).toEqual(["acme-001", "acme-002", "acme-003"]);
    expect(acmeBody.status.lastError).toBeNull();

    const widgetsBoard = await app.request("/api/repos/widgets/board", authed());
    const widgetsBody = (await widgetsBoard.json()) as { status: { lastError: string | null } };
    expect(widgetsBody.status.lastError).toBe("widgets failed");
    const aliasAfterSeed = (await (await app.request("/api/board", authed())).json()) as {
      status: { lastError: string | null; lastFetchAt: string | null };
    };
    expect(aliasAfterSeed.status.lastError).toBeNull();
    expect(aliasAfterSeed.status.lastFetchAt).toBe("2026-10-01T00:02:00.000Z");

    const details = await app.request("/api/repos/acme/initiatives/acme-003", authed());
    expect(details.status).toBe(200);
    expect(((await details.json()) as { id: string }).id).toBe("acme-003");
    const aliasDetails = await app.request("/api/initiatives/acme-003", authed());
    expect(aliasDetails.status).toBe(200);
    expect((await app.request("/api/repos/widgets/initiatives/missing", authed())).status).toBe(404);

    const acmeConfig = (await (await app.request("/api/repos/acme/edit-config", authed())).json()) as {
      enabled: boolean;
      modes: string[];
      baseBranch: string;
      canSubmit: boolean;
    };
    expect(acmeConfig).toMatchObject({
      enabled: true,
      modes: ["pr"],
      baseBranch: "develop",
      canSubmit: false,
      needsGithubWrite: false,
      defaultMode: "pr",
    });
    expect(acmeConfig).not.toHaveProperty("directBranch");
    const readerAt = Date.now();
    const widgetsConfigResponse = await app.request("/api/repos/widgets/edit-config", authed("board-reader", undefined, readerAt));
    const widgetsConfig = (await widgetsConfigResponse.json()) as { csrf?: string; canSubmit: boolean };
    expect(widgetsConfig).toMatchObject({
      enabled: true,
      modes: ["direct"],
      directBranch: "live",
      canSubmit: true,
      needsGithubWrite: false,
      defaultMode: "direct",
    });
    expect(JSON.stringify(widgetsConfig)).not.toContain("repo-bot-secret");
    expect(JSON.stringify(widgetsConfig)).not.toContain(botTokenFile);
    const aliasConfig = (await (await app.request("/api/edit-config", authed())).json()) as { baseBranch: string };
    expect(aliasConfig.baseBranch).toBe("develop");

    const now = Date.now();
    const widgetsRefresh = await app.request(
      "/api/repos/widgets/refresh",
      authed("widgets-reader", { method: "POST" }, now),
    );
    expect(widgetsRefresh.status).toBe(202);
    const widgetsLimited = await app.request(
      "/api/repos/widgets/refresh",
      authed("widgets-reader", { method: "POST" }, now),
    );
    expect(widgetsLimited.status).toBe(429);
    const acmeRefresh = await app.request("/api/repos/acme/refresh", authed("widgets-reader", { method: "POST" }, now));
    expect(acmeRefresh.status).toBe(202);
    const aliasRefresh = await app.request("/api/refresh", authed("alias-reader", { method: "POST" }, now));
    expect(aliasRefresh.status).toBe(202);
    expect(refresh).toHaveBeenCalledWith("widgets");
    expect(refresh).toHaveBeenCalledWith("acme");

    const invalid = await app.request(
      "/api/repos/acme/edits/validate",
      authed("board-reader", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
    );
    expect(invalid.status).toBe(400);
    const aliasValidate = await app.request(
      "/api/edits/validate",
      authed("board-reader", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ edits: "nope" }),
      }),
    );
    expect(aliasValidate.status).toBe(400);

    const submitBody = {
      edits: [{ kind: "setStatus", id: "acme-001", from: "idea", to: "planned" }],
      mode: "direct",
      csrf: widgetsConfig.csrf,
    };
    // A body naming another repo is refused before any credential is used.
    const mismatched = await app.request(
      "/api/repos/widgets/edits/submit",
      authed("board-reader", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...submitBody, repo: "acme" }),
      }, readerAt),
    );
    expect(mismatched.status).toBe(400);
    expect(((await mismatched.json()) as { code: string }).code).toBe("repo_mismatch");

    // The widgets bot token only ever goes to the widgets forge repo from config.
    const githubCalls: { url: string; auth: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        githubCalls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
        return new Response(JSON.stringify({ message: "Bad credentials" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    let widgetsSubmit: Response;
    try {
      widgetsSubmit = await app.request(
        "/api/repos/widgets/edits/submit",
        authed("board-reader", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...submitBody, repo: "widgets" }),
        }, readerAt),
      );
    } finally {
      vi.unstubAllGlobals();
    }
    expect(widgetsSubmit.status).toBe(401);
    const widgetsSubmitBody = (await widgetsSubmit.json()) as { code: string };
    expect(widgetsSubmitBody.code).toBe("github_auth");
    expect(githubCalls.length).toBeGreaterThan(0);
    for (const call of githubCalls) {
      expect(call.url.startsWith(`https://api.github.com/repos/${config.forge.repo}/`)).toBe(true);
      expect(call.auth).toBe("Bearer repo-bot-secret");
    }
    expect(JSON.stringify(widgetsSubmitBody)).not.toContain("repo-bot-secret");

    // A token GitHub will not let reach this repo (404) is an auth failure, not a generic error.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })));
    let unreachable: Response;
    try {
      unreachable = await app.request(
        "/api/repos/widgets/edits/submit",
        authed("board-reader", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(submitBody),
        }, readerAt),
      );
    } finally {
      vi.unstubAllGlobals();
    }
    expect(unreachable.status).toBe(401);
    expect(((await unreachable.json()) as { code: string }).code).toBe("github_auth");

    // A clone URL on GitHub must match the forge repo the token is sent to.
    setActiveRepos([
      repoConfig("acme", "Acme platform", { modes: ["pr"], baseBranch: "develop" }),
      {
        ...repoConfig("widgets", "Widgets", { modes: ["direct"], directBranch: "live", botTokenFile }),
        url: "https://github.com/someone/elsewhere.git",
      },
    ]);
    const mismatchCalls = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", mismatchCalls);
    let forgeMismatch: Response;
    try {
      forgeMismatch = await app.request(
        "/api/repos/widgets/edits/submit",
        authed("board-reader", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(submitBody),
        }, readerAt),
      );
    } finally {
      vi.unstubAllGlobals();
    }
    expect(forgeMismatch.status).toBe(409);
    expect(((await forgeMismatch.json()) as { code: string }).code).toBe("forge_mismatch");
    expect(mismatchCalls).not.toHaveBeenCalled();
    publishRepos(botTokenFile);

    const acmeSubmit = await app.request(
      "/api/repos/acme/edits/submit",
      authed("board-reader", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...submitBody, mode: "pr", csrf: "missing" }),
      }),
    );
    expect(acmeSubmit.status).toBe(403);
    expect(await acmeSubmit.json()).toEqual({
      ok: false,
      code: "read_only",
      error: "this sign-in can view the board but not submit edits",
    });

    for (const path of [
      "/api/repos/nope/board",
      "/api/repos/Nope/board",
      "/api/repos/default/board",
      "/api/repos/nope/initiatives/acme-001",
      "/api/repos/nope/initiatives/acme-001/body",
      "/api/repos/nope/edit-config",
    ]) {
      const response = await app.request(path, authed());
      expect(response.status, path).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    for (const path of ["/api/repos/nope/refresh", "/api/repos/nope/edits/validate", "/api/repos/nope/edits/submit"]) {
      const response = await app.request(
        path,
        authed("board-reader", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
      );
      expect(response.status, path).toBe(404);
    }
  });
});

function repoConfig(id: string, name: string, edit: RepoConfig["edit"]): RepoConfig {
  return { id, name, url: `https://example.com/${id}.git`, edit };
}

async function writeSecret(secret: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "snoboard-repo-bot-"));
  const file = path.join(dir, "bot");
  await writeFile(file, `${secret}\n`);
  return file;
}

describe("githubRepoFromUrl", () => {
  it("reads owner/name from GitHub clone URLs only", () => {
    expect(githubRepoFromUrl("https://github.com/example/acme.git")).toBe("example/acme");
    expect(githubRepoFromUrl("https://github.com/example/acme")).toBe("example/acme");
    expect(githubRepoFromUrl("git@github.com:example/acme.git")).toBe("example/acme");
    expect(githubRepoFromUrl("ssh://git@github.com/example/acme.git")).toBe("example/acme");
    expect(githubRepoFromUrl("https://example.com/acme.git")).toBeUndefined();
    expect(githubRepoFromUrl("/tmp/bare.git")).toBeUndefined();
    expect(githubRepoFromUrl(undefined)).toBeUndefined();
  });
});
