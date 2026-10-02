import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "snoboard";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBareClone, createTmpRepo } from "../../../packages/core/src/test-utils/tmp-repo.ts";
import { resetAuthConfig, setAuthConfig } from "./auth/env.js";
import { app } from "./index.js";
import { loadProposals, resetProposals } from "./proposals.js";
import { createRepoSync, requestRefresh } from "./repo-sync.js";
import { getSnapshot, resetStore } from "./store.js";

const EDIT_BRANCH = "snoboard/edits-20261001-120000-ab12";

const configText = `forge:
  repo: acme/board
root: initiatives
file: initiative.md
defaultBranch: main
branchPatterns: ["initiative/*"]
statuses: [idea, planned, in-progress, review, done]
doneStatuses: [done]
priorities: [p0, p1, p2, p3]
`;

function initiative(options: {
  id: string;
  title: string;
  status: string;
  priority?: string;
  phase?: string;
  body?: string;
}): string {
  const phase =
    options.phase === undefined
      ? ""
      : `phases:
  - id: 1
    title: Build
    status: ${options.phase}
`;
  return `---
id: ${options.id}
title: ${options.title}
status: ${options.status}
priority: ${options.priority ?? "p2"}
updated: 2026-09-01
${phase}---

# ${options.title}

## Summary

${options.body ?? "Keep this prose."}
`;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  resetStore();
  resetProposals();
  resetAuthConfig();
  vi.unstubAllGlobals();
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup !== undefined) await cleanup();
  }
});

describe("proposal diff", () => {
  it("reports changed fields, a new initiative, and a pull request, then drops them once the base matches", async () => {
    const config = loadConfig(configText);
    const repo = await createTmpRepo({
      commits: [
        {
          message: "main",
          files: {
            ".snoboard.yml": configText,
            "initiatives/acme/001-alpha/initiative.md": initiative({
              id: "acme-001",
              title: "Alpha",
              status: "idea",
              phase: "planned",
            }),
          },
        },
      ],
    });
    cleanups.push(() => repo.remove());
    const reviewed = initiative({
      id: "acme-001",
      title: "Alpha two",
      status: "review",
      phase: "done",
      body: "Updated prose.",
    });
    await repo.commit({
      branch: EDIT_BRANCH,
      message: "edit",
      files: {
        "initiatives/acme/001-alpha/initiative.md": reviewed,
        "initiatives/acme/003-gamma/initiative.md": initiative({
          id: "acme-003",
          title: "Gamma",
          status: "planned",
          priority: "p1",
        }),
      },
    });

    const open = await loadProposals({ repoDir: repo.dir, config, baseBranch: "main" });
    expect(open).toEqual([
      {
        branch: EDIT_BRANCH,
        initiativeId: "acme-001",
        fields: [
          { field: "title", value: "Alpha two" },
          { field: "status", value: "review" },
          { field: "phase 1", value: "done" },
          { field: "body", value: "updated" },
        ],
      },
      {
        branch: EDIT_BRANCH,
        initiativeId: "acme-003",
        fields: [
          { field: "title", value: "Gamma" },
          { field: "status", value: "planned" },
          { field: "priority", value: "p1" },
        ],
      },
    ]);

    const token = "read-token-for-pulls";
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("head")).toBe(`acme:${EDIT_BRANCH}`);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      return new Response(
        JSON.stringify([{ number: 12, html_url: "https://github.com/acme/board/pull/12", state: "open" }]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const withPull = await loadProposals({
      repoDir: repo.dir,
      config,
      baseBranch: "main",
      token,
      fetchImpl,
    });
    expect(withPull[0]?.pr).toEqual({ number: 12, url: "https://github.com/acme/board/pull/12" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await repo.commit({
      branch: "main",
      message: "merge the edit",
      files: {
        "initiatives/acme/001-alpha/initiative.md": reviewed,
        "initiatives/acme/003-gamma/initiative.md": initiative({
          id: "acme-003",
          title: "Gamma",
          status: "planned",
          priority: "p1",
        }),
      },
    });
    expect(await loadProposals({ repoDir: repo.dir, config, baseBranch: "main" })).toEqual([]);
  }, 30_000);
});

describe("edit branches on the board", () => {
  it(
    "does not turn an edit branch into a card, and drops the proposal after merge",
    async () => {
      const boardConfig = `root: initiatives
file: initiative.md
defaultBranch: main
branchPatterns: ["*"]
statuses: [planned, review, done]
doneStatuses: [done]
priorities: [p1, p2]
forge:
  repo: acme/board
`;
      const repo = await createTmpRepo({
        commits: [
          {
            message: "initial",
            files: {
              ".snoboard.yml": boardConfig,
              "initiatives/acme/001-onboarding/initiative.md": initiative({
                id: "acme-001",
                title: "Onboarding",
                status: "planned",
              }),
            },
          },
        ],
      });
      const bare = await createBareClone(repo.dir);
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "snoboard-proposals-"));
      cleanups.push(async () => {
        await repo.remove();
        await bare.remove();
        await rm(dataDir, { recursive: true, force: true });
      });
      const sync = createRepoSync({ repoUrl: bare.dir, dataDir, refreshSeconds: 3600 });
      cleanups.push(async () => {
        sync.stop();
      });

      await requestRefresh();
      expect(getSnapshot()?.items.map((item) => item.id)).toEqual(["acme-001"]);

      await repo.commit({
        branch: "tickets/acme-004",
        message: "ticket",
        files: {
          "initiatives/acme/004-billing/initiative.md": initiative({
            id: "acme-004",
            title: "Billing",
            status: "planned",
          }),
        },
      });
      await repo.commit({
        branch: EDIT_BRANCH,
        message: "propose review",
        files: {
          "initiatives/acme/001-onboarding/initiative.md": initiative({
            id: "acme-001",
            title: "Onboarding",
            status: "review",
          }),
        },
      });
      await runGit(repo.dir, ["push", bare.dir, "tickets/acme-004"]);
      await runGit(repo.dir, ["push", bare.dir, EDIT_BRANCH]);
      await requestRefresh();

      const open = getSnapshot();
      expect(open?.refs.map((ref) => ref.name).sort()).toEqual(["main", "tickets/acme-004"]);
      const onboarding = open?.items.find((item) => item.id === "acme-001");
      expect(onboarding?.status).toBe("planned");
      expect(onboarding?.sourceRef).toBe("main");
      expect(open?.items.filter((item) => item.id === "acme-001")).toHaveLength(1);
      expect(open?.items.some((item) => item.id === "acme-004")).toBe(true);
      expect(open?.items.every((item) => !item.sourceRef.startsWith("snoboard/edits-"))).toBe(true);

      setAuthConfig({ modes: ["none"] });
      const board = await app.request("/api/board");
      expect(board.status).toBe(200);
      const body = (await board.json()) as {
        proposals: { branch: string; initiativeId: string; fields: { field: string; value: string }[] }[];
      };
      expect(body.proposals).toEqual([
        {
          branch: EDIT_BRANCH,
          initiativeId: "acme-001",
          fields: [{ field: "status", value: "review" }],
        },
      ]);

      await runGit(repo.dir, ["switch", "main"]);
      await runGit(repo.dir, ["merge", "--no-edit", EDIT_BRANCH]);
      await runGit(repo.dir, ["push", bare.dir, "main"]);
      await requestRefresh();

      const merged = getSnapshot()?.items.find((item) => item.id === "acme-001");
      expect(merged?.status).toBe("review");
      expect(merged?.sourceRef).toBe("main");
      expect(getSnapshot()?.items.filter((item) => item.id === "acme-001")).toHaveLength(1);
      const after = await app.request("/api/board");
      const afterBody = (await after.json()) as { proposals: unknown[] };
      expect(afterBody.proposals).toEqual([]);
    },
    90_000,
  );
});

function runGit(repoDir: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["--no-pager", ...args], {
      cwd: repoDir,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (stdout === null || stderr === null) {
      child.kill();
      reject(new Error("git stdio was not piped"));
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    stdout.on("data", (chunk: Buffer) => out.push(chunk));
    stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if ((code ?? 1) !== 0) {
        reject(new Error(`git ${args.join(" ")} failed: ${Buffer.concat(err).toString("utf8")}`));
        return;
      }
      resolve(Buffer.concat(out).toString("utf8"));
    });
  });
}
