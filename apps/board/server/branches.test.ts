import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildGraph, loadConfig, type Config, type Snapshot } from "snoboard";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTmpRepo, type TmpRepo } from "../../../packages/core/src/test-utils/tmp-repo.ts";
import { resetAuthConfig, setAuthConfig } from "./auth/env.js";
import { SESSION_COOKIE, signSession } from "./auth/session.js";
import {
  BranchNotFoundError,
  createGitBranchSource,
  filterBranches,
  parseLsRemote,
  setBranchSource,
  sortBranches,
  type BranchSource,
} from "./branches.js";
import { app } from "./index.js";
import { branchListPatternsFor, loadReposConfig, resetActiveRepos } from "./repos-config.js";
import { resetStore, seedStore } from "./store.js";
import { randomBytes } from "node:crypto";

const secret = randomBytes(32);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  setBranchSource("default", undefined);
  resetStore();
  resetAuthConfig();
  resetActiveRepos();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function initiative(id: string, status: string): string {
  return ["---", `id: ${id}`, `title: ${id}`, `status: ${status}`, "priority: p2", "updated: 2024-01-01", "---", "", "## Summary", "", "S", ""].join("\n");
}

function emptySnapshot(items: Snapshot["items"] = []): Snapshot {
  const config = loadConfig();
  return { generatedAt: "2024-01-01T00:00:00Z", refs: [], items, legacy: [], errors: [], graph: buildGraph([], config) };
}

describe("branch list helpers", () => {
  it("parses ls-remote heads and drops names git would refuse", () => {
    const sha = "a".repeat(40);
    const heads = parseLsRemote(
      [`${sha}\trefs/heads/main`, `${sha}\trefs/heads/feat/x`, `${sha}\trefs/heads/-evil`, `${sha}\trefs/tags/v1`, "junk"].join("\n"),
    );
    expect([...heads.keys()]).toEqual(["main", "feat/x"]);
  });

  it("sorts newest first and filters case-insensitively", () => {
    const sorted = sortBranches([
      { name: "b", sha: "1", date: "2024-01-01T00:00:00Z" },
      { name: "a", sha: "2", date: "2024-03-01T00:00:00Z" },
      { name: "c", sha: "3", date: "2024-01-01T00:00:00Z" },
    ]);
    expect(sorted.map((branch) => branch.name)).toEqual(["a", "b", "c"]);
    expect(filterBranches(sorted, " B ").map((branch) => branch.name)).toEqual(["b"]);
    expect(filterBranches(sorted, "").map((branch) => branch.name)).toEqual(["a", "b", "c"]);
  });
});

describe("repos config", () => {
  it("reads edit.directBranches and branchListPatterns per repository", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "snoboard-repos-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, "repos.yaml");
    await writeFile(
      file,
      [
        "repos:",
        "  - id: one",
        "    name: One",
        "    url: https://github.com/acme/one.git",
        "    branchListPatterns: [\"feat/*\", main]",
        "    edit:",
        "      modes: [direct]",
        "      directBranch: main",
        "      directBranches: [main, \"feat/*\"]",
        "  - id: two",
        "    name: Two",
        "    url: https://github.com/acme/two.git",
      ].join("\n"),
    );
    const repos = loadReposConfig({ SNOBOARD_REPOS_FILE: file });
    expect(repos[0]?.edit.directBranches).toEqual(["main", "feat/*"]);
    expect(repos[0]?.branchListPatterns).toEqual(["feat/*", "main"]);
    expect(repos[1]?.branchListPatterns).toBeUndefined();
    expect(branchListPatternsFor("default", {})).toEqual(["*"]);
    await writeFile(
      file,
      ["repos:", "  - id: one", "    name: One", "    url: https://github.com/acme/one.git", "    edit:", "      modes: [direct]", "      directBranch: main", "      directBranches: [\"-x\"]"].join("\n"),
    );
    expect(() => loadReposConfig({ SNOBOARD_REPOS_FILE: file })).toThrow(/invalid branch pattern/);
  });
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

describe("git branch source", () => {
  let origin: TmpRepo;
  let cloneDir: string;
  let config: Config;
  let fetches: string[][];
  let source: BranchSource;

  beforeEach(async () => {
    origin = await createTmpRepo();
    cleanups.push(() => origin.remove());
    await origin.commit({ files: { "initiatives/acme/001-one/initiative.md": initiative("acme-001", "planned") }, date: "2024-01-01T00:00:00Z" });
    await origin.commit({ branch: "feat/old", files: { "initiatives/acme/001-one/initiative.md": initiative("acme-001", "review") }, date: "2024-02-01T00:00:00Z" });
    await origin.commit({ branch: "fix/new", files: { "initiatives/acme/002-two/initiative.md": initiative("acme-002", "idea") }, date: "2024-05-01T00:00:00Z" });
    await origin.commit({ branch: "main", files: { "initiatives/acme/003-three/initiative.md": initiative("acme-003", "idea") }, date: "2024-03-01T00:00:00Z" });
    git(origin.dir, ["config", "uploadpack.allowFilter", "true"]);
    git(origin.dir, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
    const parent = await mkdtemp(path.join(os.tmpdir(), "snoboard-clone-"));
    cleanups.push(() => rm(parent, { recursive: true, force: true }));
    cloneDir = path.join(parent, "repo");
    git(parent, ["clone", "--filter=blob:none", "--no-checkout", "--single-branch", pathToFileURL(origin.dir).href, cloneDir]);
    config = loadConfig();
    fetches = [];
    source = makeSource(["*"]);
  }, 60_000);

  function makeSource(patterns: string[]): BranchSource {
    return createGitBranchSource({
      repoDir: cloneDir,
      git: async (args, options) => {
        if (args[0] === "fetch") fetches.push([...args]);
        const result = spawnSync("git", ["--no-pager", ...args], {
          cwd: cloneDir,
          encoding: "utf8",
          windowsHide: true,
          env: { ...process.env, ...options?.env },
        });
        if (result.status !== 0) throw new Error(result.stderr);
        return result.stdout;
      },
      withLock: (task) => task(),
      config: () => config,
      patterns: () => patterns,
      ttlMs: 60_000,
    });
  }

  it("lists every remote head newest first with its date, metadata only", async () => {
    const list = await source.list();
    expect(list.defaultBranch).toBe("main");
    expect(list.branches.map((branch) => branch.name)).toEqual(["fix/new", "main", "feat/old"]);
    expect(Date.parse(list.branches[0]?.date ?? "")).toBe(Date.parse("2024-05-01T00:00:00Z"));
    expect(list.branches.every((branch) => /^[0-9a-f]{40}$/.test(branch.sha))).toBe(true);
    expect(fetches.every((args) => args.includes("--filter=blob:none"))).toBe(true);
    // The merged snapshot's namespace is untouched.
    expect(git(cloneDir, ["for-each-ref", "refs/remotes/origin/"])).not.toContain("feat/old");
  });

  it("honours branchListPatterns but keeps the default branch", async () => {
    const list = await makeSource(["feat/*"]).list();
    expect(list.branches.map((branch) => branch.name)).toEqual(["main", "feat/old"]);
  });

  it("builds a snapshot of one branch alone and caches it", async () => {
    const view = await source.snapshot("feat/old");
    expect(view.snapshot.items.map((item) => [item.id, item.status])).toEqual([["acme-001", "review"]]);
    expect(view.snapshot.refs).toEqual([expect.objectContaining({ name: "feat/old", isDefault: true })]);
    const before = fetches.length;
    expect(await source.snapshot("feat/old")).toBe(view);
    expect(fetches.length).toBe(before);
    const main = await source.snapshot("main");
    expect(main.snapshot.items.map((item) => item.id)).toEqual(["acme-001", "acme-003"]);
  });

  it("fetches a branch outside the list patterns on demand", async () => {
    const narrow = makeSource(["feat/*"]);
    const view = await narrow.snapshot("fix/new");
    expect(view.snapshot.items.map((item) => item.id)).toEqual(["acme-001", "acme-002"]);
  });

  it("refuses unknown and invalid branches", async () => {
    await expect(source.snapshot("nope")).rejects.toBeInstanceOf(BranchNotFoundError);
    await expect(source.snapshot("../main")).rejects.toBeInstanceOf(BranchNotFoundError);
    await expect(source.snapshot("-main")).rejects.toBeInstanceOf(BranchNotFoundError);
  });
});

describe("GET /api/repos/<repo>/branches and ?ref=", () => {
  function cookie(): string {
    const iat = Date.now();
    return `${SESSION_COOKIE}=${signSession(secret, { sub: "reader", method: "password", iat, exp: iat + 3_600_000 })}`;
  }

  beforeEach(() => {
    setAuthConfig({
      modes: ["password"],
      publicUrl: "http://localhost:3000",
      sessionSecret: secret,
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$aaaaaaaaaaaaaaaa$bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
    seedStore(emptySnapshot(), loadConfig());
    const branchItem = { id: "acme-009", title: "On branch" } as unknown as Snapshot["items"][number];
    setBranchSource("default", {
      list: async () => ({
        defaultBranch: "main",
        truncated: false,
        branches: [
          { name: "feat/new", sha: "b".repeat(40), date: "2024-05-01T00:00:00Z" },
          { name: "main", sha: "a".repeat(40), date: "2024-03-01T00:00:00Z" },
          { name: "feat/old", sha: "c".repeat(40), date: "2024-01-01T00:00:00Z" },
        ],
      }),
      snapshot: async (name) => {
        if (name !== "feat/new") throw new BranchNotFoundError();
        return { name, sha: "b".repeat(40), snapshot: emptySnapshot([branchItem]) };
      },
      forget: () => undefined,
    });
  });

  it("needs a session like /api/board", async () => {
    expect((await app.request("/api/repos/default/branches")).status).toBe(401);
  });

  it("lists branches in server order with short shas, filtered by ?q=", async () => {
    const all = await app.request("/api/repos/default/branches", { headers: { cookie: cookie() } });
    expect(all.status).toBe(200);
    const body = (await all.json()) as { defaultBranch: string; branches: { name: string; sha: string }[] };
    expect(body.defaultBranch).toBe("main");
    expect(body.branches.map((branch) => branch.name)).toEqual(["feat/new", "main", "feat/old"]);
    expect(body.branches[0]?.sha).toBe("bbbbbbb");
    const some = await app.request("/api/repos/default/branches?q=FEAT", { headers: { cookie: cookie() } });
    expect(((await some.json()) as { branches: { name: string }[] }).branches.map((branch) => branch.name)).toEqual([
      "feat/new",
      "feat/old",
    ]);
    expect((await app.request("/api/repos/other/branches", { headers: { cookie: cookie() } })).status).toBe(404);
  });

  it("serves the board of one branch with ?ref= and refuses bad or unknown names", async () => {
    const view = await app.request("/api/repos/default/board?ref=feat%2Fnew", { headers: { cookie: cookie() } });
    expect(view.status).toBe(200);
    const body = (await view.json()) as { ref: string; items: { id: string }[] };
    expect(body.ref).toBe("feat/new");
    expect(body.items.map((item) => item.id)).toEqual(["acme-009"]);
    const merged = await app.request("/api/repos/default/board", { headers: { cookie: cookie() } });
    expect(((await merged.json()) as { ref?: string }).ref).toBeUndefined();
    for (const bad of ["..%2Fmain", "-x", "a%20b", "refs%2Fheads%2Fmain"]) {
      const response = await app.request(`/api/repos/default/board?ref=${bad}`, { headers: { cookie: cookie() } });
      expect(response.status).toBe(400);
    }
    const missing = await app.request("/api/repos/default/board?ref=gone", { headers: { cookie: cookie() } });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "branch_not_found" });
  });
});
