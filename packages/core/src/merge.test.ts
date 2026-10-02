import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "./config.js";
import { lastCommitsForPaths } from "./git.js";
import { blockedBy, isReady } from "./graph.js";
import {
  buildSnapshot as exportedBuildSnapshot,
  lastCommitsForPaths as exportedLastCommitsForPaths,
} from "./index.js";
import { buildSnapshot, type BoardItem, type Snapshot } from "./merge.js";
import { addRemote, createBareClone, createTmpRepo, type TmpRepo } from "./test-utils/tmp-repo.js";

const config = loadConfig();

const repos: Array<{ remove(): Promise<void> }> = [];

afterEach(async () => {
  const pending = repos.splice(0);
  for (const repo of pending.reverse()) {
    await repo.remove();
  }
});

function track<T extends { remove(): Promise<void> }>(repo: T): T {
  repos.push(repo);
  return repo;
}

function initiative(fields: {
  id: string;
  title: string;
  status: string;
  summary: string;
  dependsOn?: readonly string[];
  phases?: boolean;
}): string {
  const lines = [
    "---",
    `id: ${fields.id}`,
    `title: ${fields.title}`,
    `status: ${fields.status}`,
    "priority: p2",
  ];
  if (fields.dependsOn !== undefined && fields.dependsOn.length > 0) {
    const quoted = fields.dependsOn.map((id) => JSON.stringify(id)).join(", ");
    lines.push(`depends_on: [${quoted}]`);
  }
  lines.push("updated: 2026-09-01");
  if (fields.phases === true) {
    lines.push(
      "phases:",
      "  - id: 1",
      "    title: Account setup",
      "    status: done",
      "  - id: 2",
      "    title: First project",
      "    status: done",
      "    depends_on: [1]",
    );
  }
  lines.push("---", "", "## Summary", "", fields.summary, "");
  return lines.join("\n");
}

function legacyFile(title: string, summary: string): string {
  return ["# " + title, "", "## Summary", "", summary, ""].join("\n");
}

function brokenFile(id: string): string {
  return ["---", `id: ${id}`, "status: planned", "---", "", "# Broken", ""].join("\n");
}

function byId(snapshot: Snapshot, id: string): BoardItem {
  const found = snapshot.items.find((entry) => entry.id === id);
  if (found === undefined) {
    throw new Error(`missing item ${id}`);
  }
  return found;
}

function treeIsh(args: readonly string[]): string {
  const marker = args.indexOf("--");
  const revision = marker > 0 ? args[marker - 1] : undefined;
  if (revision === undefined) {
    throw new Error(`missing revision in git ${args.join(" ")}`);
  }
  return revision;
}

function gitOk(repoDir: string, args: readonly string[]): void {
  const result = spawnSync("git", ["--no-pager", ...args], {
    cwd: repoDir,
    encoding: "utf8",
    windowsHide: true,
  });
  expect(result.status, result.stderr).toBe(0);
}

describe("buildSnapshot", () => {
  it("exports the snapshot builder", async () => {
    expect(exportedBuildSnapshot).toBe(buildSnapshot);
    expect(exportedLastCommitsForPaths).toBe(lastCommitsForPaths);
    const source = await readFile(new URL("./merge.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });

  it("merges the default branch and matching branches", async () => {
    const repo = track(await createTmpRepo());
    const mainSha = await repo.commit({
      date: "2024-01-01T00:00:00Z",
      message: "main initiatives",
      files: {
        "initiatives/acme/001-onboarding/initiative.md": initiative({
          id: "acme-001",
          title: "Customer onboarding",
          status: "done",
          summary: "Onboarding is done.",
          phases: true,
        }),
        "initiatives/acme/002-billing/initiative.md": initiative({
          id: "acme-002",
          title: "Billing",
          status: "planned",
          summary: "Billing is planned.",
          dependsOn: ["acme-001"],
        }),
        "initiatives/acme/004-portal/initiative.md": initiative({
          id: "acme-004",
          title: "Portal",
          status: "planned",
          summary: "Portal waits on billing.",
          dependsOn: ["acme-002"],
        }),
        "initiatives/acme/007-stable/initiative.md": initiative({
          id: "acme-007",
          title: "Stable",
          status: "planned",
          summary: "Unchanged on branches.",
        }),
        "initiatives/acme/008-phase/initiative.md": initiative({
          id: "acme-008",
          title: "Phase follow-up",
          status: "planned",
          summary: "Waits on a finished phase.",
          dependsOn: ["acme-001#2"],
        }),
        "initiatives/acme/010-followup/initiative.md": initiative({
          id: "acme-010",
          title: "Follow-up",
          status: "planned",
          summary: "Follows onboarding.",
          dependsOn: ["acme-001"],
        }),
        "initiatives/acme/011-closeout/initiative.md": initiative({
          id: "acme-011",
          title: "Closeout",
          status: "planned",
          summary: "Closeout is planned.",
        }),
        "initiatives/acme/012-wrapup/initiative.md": initiative({
          id: "acme-012",
          title: "Wrap-up",
          status: "planned",
          summary: "Wraps up.",
          dependsOn: ["acme-011", "acme-002"],
        }),
        "initiatives/platform/001-ci/initiative.md": legacyFile(
          "Continuous integration",
          "Run checks on every change.",
        ),
        "initiatives/platform/003-broken/initiative.md": brokenFile("platform-003"),
      },
    });
    const billingOld = await repo.commit({
      branch: "initiative/billing",
      date: "2024-04-01T00:00:00Z",
      message: "audit started",
      files: {
        "initiatives/acme/006-audit/initiative.md": initiative({
          id: "acme-006",
          title: "Audit",
          status: "in-progress",
          summary: "Audit started.",
        }),
      },
    });
    const billingNew = await repo.commit({
      branch: "initiative/billing",
      date: "2024-06-01T00:00:00Z",
      message: "billing progress",
      files: {
        "initiatives/acme/001-onboarding/initiative.md": initiative({
          id: "acme-001",
          title: "Customer onboarding",
          status: "in-progress",
          summary: "Onboarding restarted.",
        }),
        "initiatives/acme/002-billing/initiative.md": initiative({
          id: "acme-002",
          title: "Billing",
          status: "in-progress",
          summary: "Billing is underway.",
          dependsOn: ["acme-001"],
        }),
        "initiatives/acme/011-closeout/initiative.md": initiative({
          id: "acme-011",
          title: "Closeout",
          status: "done",
          summary: "Closeout finished on the branch.",
        }),
      },
    });
    const reportsOld = await repo.commit({
      branch: "initiative/reports",
      date: "2024-03-01T00:00:00Z",
      message: "exports branch",
      files: {
        "initiatives/acme/003-exports/initiative.md": initiative({
          id: "acme-003",
          title: "Exports",
          status: "planned",
          summary: "Exports live only here.",
        }),
        "initiatives/platform/001-ci/initiative.md": legacyFile(
          "Continuous integration",
          "Branch legacy should be ignored.",
        ),
        "initiatives/platform/002-scripts/initiative.md": legacyFile(
          "Branch scripts",
          "Branch only legacy.",
        ),
        "initiatives/platform/004-branch-broken/initiative.md": brokenFile("platform-004"),
      },
    });
    const reportsNew = await repo.commit({
      branch: "initiative/reports",
      date: "2024-05-01T00:00:00Z",
      message: "audit review",
      files: {
        "initiatives/acme/006-audit/initiative.md": initiative({
          id: "acme-006",
          title: "Audit",
          status: "review",
          summary: "Audit in review.",
        }),
      },
    });
    await repo.commit({
      branch: "topic/scratch",
      date: "2024-07-01T00:00:00Z",
      message: "ignored branch",
      files: {
        "initiatives/acme/099-hidden/initiative.md": initiative({
          id: "acme-099",
          title: "Hidden",
          status: "planned",
          summary: "Hidden.",
        }),
      },
    });

    const commands: string[][] = [];
    const snapshot = await buildSnapshot(repo.dir, config, {
      onSpawn: (args) => {
        commands.push([...args]);
      },
    });

    expect(snapshot.refs.map((ref) => [ref.name, ref.isDefault, ref.sha])).toEqual([
      ["initiative/billing", false, billingNew],
      ["initiative/reports", false, reportsNew],
      ["main", true, mainSha],
    ]);
    expect(Date.parse(snapshot.generatedAt)).toBeGreaterThan(Date.now() - 120_000);
    expect(snapshot.items.map((item) => item.id)).toEqual([
      "acme-001",
      "acme-002",
      "acme-003",
      "acme-004",
      "acme-006",
      "acme-007",
      "acme-008",
      "acme-010",
      "acme-011",
      "acme-012",
    ]);

    const doneOnMain = byId(snapshot, "acme-001");
    expect(doneOnMain).toMatchObject({
      status: "done",
      sourceRef: "main",
      sourceSha: mainSha,
      summary: "Onboarding is done.",
      project: "acme",
      number: "001",
      path: "initiatives/acme/001-onboarding/initiative.md",
      updated: "2026-09-01",
      onBranches: ["initiative/billing"],
      isReady: false,
      blockedBy: [],
    });
    expect(Date.parse(doneOnMain.updatedAt)).toBe(Date.parse("2024-01-01T00:00:00Z"));

    const branchWins = byId(snapshot, "acme-002");
    expect(branchWins).toMatchObject({
      status: "in-progress",
      sourceRef: "initiative/billing",
      sourceSha: billingNew,
      summary: "Billing is underway.",
      depends_on: ["acme-001"],
      isReady: true,
      blockedBy: [],
    });
    expect(Date.parse(branchWins.updatedAt)).toBe(Date.parse("2024-06-01T00:00:00Z"));

    const branchOnly = byId(snapshot, "acme-003");
    expect(branchOnly).toMatchObject({
      status: "planned",
      sourceRef: "initiative/reports",
      sourceSha: reportsOld,
      summary: "Exports live only here.",
      onBranches: ["initiative/reports"],
      isReady: true,
      blockedBy: [],
    });
    expect(branchOnly.sourceSha).not.toBe(reportsNew);
    expect(Date.parse(branchOnly.updatedAt)).toBe(Date.parse("2024-03-01T00:00:00Z"));

    expect(byId(snapshot, "acme-006")).toMatchObject({
      status: "review",
      sourceRef: "initiative/reports",
      sourceSha: reportsNew,
      summary: "Audit in review.",
      onBranches: ["initiative/billing", "initiative/reports"],
    });
    expect(billingOld).not.toBe(reportsNew);

    expect(byId(snapshot, "acme-007")).toMatchObject({
      sourceRef: "main",
      sourceSha: mainSha,
      summary: "Unchanged on branches.",
      onBranches: [],
    });

    expect(byId(snapshot, "acme-011")).toMatchObject({
      status: "done",
      sourceRef: "initiative/billing",
      sourceSha: billingNew,
      summary: "Closeout finished on the branch.",
      isReady: false,
    });

    expect(byId(snapshot, "acme-004")).toMatchObject({
      isReady: false,
      blockedBy: ["acme-002"],
    });
    expect(byId(snapshot, "acme-010")).toMatchObject({
      isReady: true,
      blockedBy: [],
    });
    expect(byId(snapshot, "acme-008")).toMatchObject({
      sourceRef: "main",
      depends_on: ["acme-001#2"],
      isReady: true,
      blockedBy: [],
    });
    expect(byId(snapshot, "acme-012")).toMatchObject({
      isReady: false,
      blockedBy: ["acme-002"],
    });

    expect(snapshot.graph.nodes.get("acme-001")?.status).toBe("done");
    expect(snapshot.graph.nodes.get("acme-001#2")?.status).toBe("done");
    expect(snapshot.graph.nodes.get("acme-002")?.status).toBe("in-progress");
    expect(snapshot.graph.nodes.get("acme-011")?.status).toBe("done");
    for (const item of snapshot.items) {
      expect(item.isReady).toBe(isReady(snapshot.graph, item.id));
      expect(item.blockedBy).toEqual(blockedBy(snapshot.graph, item.id));
    }

    expect(snapshot.legacy).toEqual([
      {
        path: "initiatives/platform/001-ci/initiative.md",
        project: "platform",
        number: "001",
        title: "Continuous integration",
        summary: "Run checks on every change.",
      },
    ]);
    expect(snapshot.errors.map((error) => [error.path, error.ref])).toEqual([
      ["initiatives/platform/003-broken/initiative.md", "main"],
      ["initiatives/platform/004-branch-broken/initiative.md", "initiative/reports"],
    ]);
    expect(snapshot.errors.every((error) => error.message.length > 0)).toBe(true);

    const logs = commands.filter((args) => args.includes("log"));
    const trees = commands.filter((args) => args[0] === "ls-tree");
    const tipShas = new Set(snapshot.refs.map((ref) => ref.sha));
    expect(logs).toHaveLength(snapshot.refs.length);
    expect(trees).toHaveLength(snapshot.refs.length);
    expect(commands.filter((args) => args[0] === "cat-file")).toEqual([
      ["cat-file", "--batch-check"],
      ["cat-file", "--batch"],
    ]);
    expect(commands.filter((args) => args[0] === "fetch")).toEqual([]);
    for (const args of logs) {
      expect(args).toContain("--format=%x00%H%x09%cI");
      expect(args).toContain("--name-only");
      expect(args).not.toContain("-1");
      const revision = treeIsh(args);
      expect(revision).toMatch(/^[0-9a-f]{40}$/);
      expect(tipShas.has(revision)).toBe(true);
    }
    for (const args of trees) {
      const revision = treeIsh(args);
      expect(revision).toMatch(/^[0-9a-f]{40}$/);
      expect(tipShas.has(revision)).toBe(true);
    }
  }, 60_000);

  it("treats a configured done status on the default branch as authoritative", async () => {
    const shipped: Config = loadConfig(
      ["statuses: [planned, in-progress, shipped]", "doneStatuses: [shipped]", ""].join("\n"),
    );
    const repo = track(await createTmpRepo());
    const mainSha = await repo.commit({
      date: "2024-01-01T00:00:00Z",
      files: {
        "initiatives/acme/001-onboarding/initiative.md": initiative({
          id: "acme-001",
          title: "Customer onboarding",
          status: "shipped",
          summary: "Shipped on main.",
        }),
        "initiatives/acme/002-billing/initiative.md": initiative({
          id: "acme-002",
          title: "Billing",
          status: "planned",
          summary: "Waits on onboarding.",
          dependsOn: ["acme-001"],
        }),
      },
    });
    await repo.commit({
      branch: "initiative/billing",
      date: "2024-06-01T00:00:00Z",
      files: {
        "initiatives/acme/001-onboarding/initiative.md": initiative({
          id: "acme-001",
          title: "Customer onboarding",
          status: "in-progress",
          summary: "Reopened on the branch.",
        }),
      },
    });

    const snapshot = await buildSnapshot(repo.dir, shipped);
    expect(byId(snapshot, "acme-001")).toMatchObject({
      status: "shipped",
      sourceRef: "main",
      sourceSha: mainSha,
      summary: "Shipped on main.",
    });
    expect(byId(snapshot, "acme-002")).toMatchObject({
      isReady: true,
      blockedBy: [],
    });
    expect(byId(snapshot, "acme-002").isReady).toBe(isReady(snapshot.graph, "acme-002"));
  }, 30_000);

  it("reports a branch parse error when the branch changed a file that is valid on main", async () => {
    const repo = track(await createTmpRepo());
    await repo.commit({
      date: "2024-01-01T00:00:00Z",
      files: {
        "initiatives/acme/001-onboarding/initiative.md": initiative({
          id: "acme-001",
          title: "Customer onboarding",
          status: "planned",
          summary: "Valid on main.",
        }),
      },
    });
    await repo.commit({
      branch: "initiative/broken",
      date: "2024-02-01T00:00:00Z",
      files: {
        "initiatives/acme/001-onboarding/initiative.md": "---\nid: acme-001\nstatus: [unclosed\n---\n# Broken\n",
      },
    });

    const snapshot = await buildSnapshot(repo.dir, config);
    expect(snapshot.errors.map((error) => [error.path, error.ref])).toEqual([
      ["initiatives/acme/001-onboarding/initiative.md", "initiative/broken"],
    ]);
    expect(byId(snapshot, "acme-001")).toMatchObject({ sourceRef: "main" });
  }, 30_000);

  it("does not list a branch whose copy is only older than main", async () => {
    const repo = track(await createTmpRepo());
    const file = "initiatives/acme/001-onboarding/initiative.md";
    await repo.commit({
      date: "2024-01-01T00:00:00Z",
      files: { [file]: initiative({ id: "acme-001", title: "Onboarding", status: "planned", summary: "Old." }) },
    });
    await repo.commit({
      branch: "initiative/other",
      date: "2024-02-01T00:00:00Z",
      files: { "initiatives/acme/002-équipe/initiative.md": initiative({ id: "acme-002", title: "Other", status: "planned", summary: "Other." }) },
    });
    await repo.commit({
      date: "2024-03-01T00:00:00Z",
      files: { [file]: initiative({ id: "acme-001", title: "Onboarding", status: "in-progress", summary: "New on main." }) },
    });

    const snapshot = await buildSnapshot(repo.dir, config);
    expect(byId(snapshot, "acme-001")).toMatchObject({ status: "in-progress", sourceRef: "main", onBranches: [] });
    expect(byId(snapshot, "acme-002").onBranches).toEqual(["initiative/other"]);
  }, 30_000);

  it("reads a partial clone by commit sha and does not fetch", async () => {
    const source: TmpRepo = track(
      await createTmpRepo({
        commits: [
          {
            date: "2024-01-01T00:00:00Z",
            files: {
              "initiatives/acme/001-onboarding/initiative.md": initiative({
                id: "acme-001",
                title: "Customer onboarding",
                status: "done",
                summary: "From main.",
              }),
            },
          },
          {
            branch: "initiative/exports",
            date: "2024-02-01T00:00:00Z",
            files: {
              "initiatives/acme/003-exports/initiative.md": initiative({
                id: "acme-003",
                title: "Exports",
                status: "planned",
                summary: "From branch.",
              }),
            },
          },
        ],
      }),
    );
    const bare = track(await createBareClone(source.dir));
    const mirror = track(await createTmpRepo());
    await addRemote(mirror.dir, bare.dir, "upstream");
    gitOk(mirror.dir, [
      "fetch",
      "--prune",
      "--filter=blob:none",
      "upstream",
      "+refs/heads/*:refs/remotes/upstream/*",
    ]);
    const localMain = spawnSync(
      "git",
      ["rev-parse", "--verify", "--quiet", "refs/heads/main"],
      { cwd: mirror.dir, encoding: "utf8", windowsHide: true },
    );
    expect(localMain.status).not.toBe(0);

    const withoutRemote = await buildSnapshot(mirror.dir, config);
    expect(withoutRemote.items).toEqual([]);

    const commands: string[][] = [];
    const snapshot = await buildSnapshot(mirror.dir, config, {
      remote: "upstream",
      onSpawn: (args) => {
        commands.push([...args]);
      },
    });

    expect(commands.filter((args) => args[0] === "for-each-ref").map((args) => args.at(-1))).toEqual([
      "refs/remotes/upstream/",
    ]);
    // No ref fetch; only one batched blob prefetch for the partial clone.
    const fetches = commands.filter((args) => args.includes("fetch"));
    expect(fetches).toHaveLength(1);
    expect(fetches[0]).toContain("--no-write-fetch-head");
    expect(fetches[0]?.some((arg) => arg.startsWith("+refs/"))).toBe(false);
    expect(snapshot.items.map((item) => item.id)).toEqual(["acme-001", "acme-003"]);
    expect(byId(snapshot, "acme-001")).toMatchObject({
      sourceRef: "main",
      summary: "From main.",
      status: "done",
    });
    expect(byId(snapshot, "acme-003")).toMatchObject({
      sourceRef: "initiative/exports",
      summary: "From branch.",
      onBranches: ["initiative/exports"],
    });
    expect(await readdir(mirror.dir)).not.toContain("initiatives");

    const logs = commands.filter((args) => args.includes("log"));
    const trees = commands.filter((args) => args[0] === "ls-tree");
    const tipShas = new Set(snapshot.refs.map((ref) => ref.sha));
    expect(logs).toHaveLength(snapshot.refs.length);
    expect(trees).toHaveLength(snapshot.refs.length);
    expect(commands.filter((args) => args[0] === "cat-file" && args[1] === "--batch")).toHaveLength(1);
    for (const args of [...logs, ...trees]) {
      const revision = treeIsh(args);
      expect(revision).toMatch(/^[0-9a-f]{40}$/);
      expect(tipShas.has(revision)).toBe(true);
    }
  }, 60_000);
});
