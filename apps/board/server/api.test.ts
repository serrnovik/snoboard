import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildGraph, buildSnapshot, loadConfig, type Config, type Snapshot } from "snoboard";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTmpRepo } from "../../../packages/core/src/test-utils/tmp-repo.ts";
import { resetRefreshLimits } from "./api.js";
import { resetAuthConfig, setAuthConfig } from "./auth/env.js";
import { resetForgeCache } from "./forge/github.js";
import { SESSION_COOKIE, signSession } from "./auth/session.js";
import { app } from "./index.js";
import { resetStore, seedStore } from "./store.js";

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
    resetRefreshLimits();
    resetForgeCache();
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
      config: { statuses: string[]; priorities: string[]; doneStatuses: string[] };
      items: Array<{ id: string }>;
      legacy: Array<{ path: string }>;
      errors: Array<{ path: string }>;
      refs: Array<{ name: string }>;
    };
    expect(Object.keys(body).sort()).toEqual(
      ["config", "errors", "items", "legacy", "refs", "status"].sort(),
    );
    expect(body.config).toEqual({
      statuses: config.statuses,
      priorities: config.priorities,
      doneStatuses: config.doneStatuses,
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
});
