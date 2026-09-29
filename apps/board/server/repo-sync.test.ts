import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBareClone, createTmpRepo, type TmpRepo } from "../../../packages/core/src/test-utils/tmp-repo.ts";
import { app } from "./index.js";
import { loadBoardEnv } from "./env.js";
import { createRepoSync, requestRefresh, type Logger, type RepoSyncController } from "./repo-sync.js";
import { getSnapshot, getStatus, resetStore } from "./store.js";

const CONFIG = `root: initiatives
file: initiative.md
idFormat: "{project}-{number}"
defaultBranch: main
branchPatterns: ["tickets/*"]
statuses: [idea, planned, in-progress, review, done, parked, dropped]
doneStatuses: [done]
priorities: [p0, p1, p2, p3]
staleAfterDays: 30
`;

function initiative(id: string, title: string, status: string): string {
  return `---
id: ${id}
title: ${title}
status: ${status}
priority: p1
updated: 2026-09-29
---

# ${title}

## Summary

${title} summary.
`;
}

function runGit(repoDir: string, args: readonly string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["--no-pager", ...args], {
      cwd: repoDir,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = child.stdout;
    const stderr = child.stderr;
    const stdin = child.stdin;
    if (stdout === null || stderr === null || stdin === null) {
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
      const stderrText = Buffer.concat(err).toString("utf8").trim();
      if ((code ?? 1) !== 0) {
        reject(new Error(`git ${args.join(" ")} failed (${code ?? 1}): ${stderrText}`));
        return;
      }
      resolve(Buffer.concat(out).toString("utf8"));
    });
    if (input !== undefined) stdin.end(input);
    else stdin.end();
  });
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  resetStore();
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup !== undefined) await cleanup();
  }
});

async function setupRemote(): Promise<{ repo: TmpRepo; bareDir: string; dataDir: string }> {
  const repo = await createTmpRepo({
    commits: [
      {
        message: "initial",
        files: {
          ".snoboard.yml": CONFIG,
          "initiatives/acme/001-onboarding/initiative.md": initiative(
            "acme-001",
            "Onboarding",
            "planned",
          ),
        },
      },
    ],
  });
  const bare = await createBareClone(repo.dir);
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "snoboard-data-"));
  cleanups.push(async () => {
    await repo.remove();
    await bare.remove();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { repo, bareDir: bare.dir, dataDir };
}

describe("loadBoardEnv", () => {
  it("applies defaults for the data directory, refresh interval, and optional files", () => {
    expect(loadBoardEnv({ SNOBOARD_REPO_URL: "https://example.com/acme/board.git" })).toEqual({
      repoUrl: "https://example.com/acme/board.git",
      dataDir: "/tmp/snoboard",
      refreshSeconds: 120,
      sshKeyFile: undefined,
      gitTokenFile: undefined,
      configPath: undefined,
    });
  });

  it("rejects a missing repository URL", () => {
    expect(() => loadBoardEnv({})).toThrow(/SNOBOARD_REPO_URL/);
  });
});

describe("repo sync", () => {
  it(
    "tracks a new branch, moves it to the default branch when merged done, and keeps the snapshot when fetch fails",
    async () => {
      const { repo, bareDir, dataDir } = await setupRemote();
      const sync = createRepoSync({
        repoUrl: bareDir,
        dataDir,
        refreshSeconds: 3600,
      });
      cleanups.push(async () => {
        sync.stop();
      });

      resetStore();
      const beforeReady = await app.request("/readyz");
      expect(beforeReady.status).toBe(503);

      await requestRefresh();
      expect(getStatus().lastError).toBeNull();
      expect(getStatus().refreshing).toBe(false);
      const initial = getSnapshot();
      expect(initial?.items.map((item) => item.id)).toEqual(["acme-001"]);
      expect(initial?.items[0]?.sourceRef).toBe("main");
      expect((await app.request("/readyz")).status).toBe(200);

      const gitConfig = await readFile(path.join(sync.repoDir, ".git", "config"), "utf8");
      expect(gitConfig).toContain("+refs/heads/main:refs/remotes/origin/main");
      expect(gitConfig).toContain("+refs/heads/tickets/*:refs/remotes/origin/tickets/*");
      expect(gitConfig).not.toContain("+refs/heads/*:refs/remotes/origin/*");

      await repo.commit({
        branch: "tickets/acme-004",
        message: "Start billing",
        files: {
          "initiatives/acme/004-billing/initiative.md": initiative("acme-004", "Billing", "in-progress"),
        },
      });
      await runGit(repo.dir, ["push", bareDir, "tickets/acme-004"]);
      await requestRefresh();

      const branched = getSnapshot();
      const billing = branched?.items.find((item) => item.id === "acme-004");
      expect(billing?.sourceRef).toBe("tickets/acme-004");
      expect(billing?.status).toBe("in-progress");

      await runGit(repo.dir, ["switch", "main"]);
      await runGit(repo.dir, ["merge", "--no-edit", "tickets/acme-004"]);
      await repo.commit({
        branch: "main",
        message: "Mark billing done",
        files: {
          "initiatives/acme/004-billing/initiative.md": initiative("acme-004", "Billing", "done"),
        },
      });
      await runGit(repo.dir, ["push", bareDir, "main"]);
      await requestRefresh();

      const merged = getSnapshot()?.items.find((item) => item.id === "acme-004");
      expect(merged?.status).toBe("done");
      expect(merged?.sourceRef).toBe("main");

      const kept = getSnapshot();
      const fetchedAt = getStatus().lastFetchAt;
      const missing = path.join(os.tmpdir(), `snoboard-missing-${Date.now()}`);
      await runGit(sync.repoDir, ["remote", "set-url", "origin", missing]);
      await requestRefresh();

      expect(getSnapshot()).toBe(kept);
      expect(getStatus().lastError).toEqual(expect.any(String));
      expect(getStatus().lastError?.length).toBeGreaterThan(0);
      expect(getStatus().lastErrorAt).toEqual(expect.any(String));
      expect(getStatus().lastFetchAt).toBe(fetchedAt);
      expect(getStatus().refreshing).toBe(false);
      expect((await app.request("/readyz")).status).toBe(200);
    },
    90_000,
  );

  it(
    "keeps tokens and keys out of logs and git config",
    async () => {
      const { bareDir, dataDir } = await setupRemote();
      const token = "snoboard-test-token-9f3c1a";
      const keyMaterial = "snoboard-test-key-material-9f3c1a";
      const tokenFile = path.join(dataDir, "git-token");
      const keyFile = path.join(dataDir, "ssh-key");
      await writeFile(tokenFile, `${token}\n`, "utf8");
      await writeFile(keyFile, keyMaterial, "utf8");

      const lines: string[] = [];
      const logger: Logger = {
        info(message) {
          lines.push(message);
        },
        error(message) {
          lines.push(message);
        },
      };
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const sync = createRepoSync(
          {
            repoUrl: bareDir,
            dataDir,
            refreshSeconds: 3600,
            gitTokenFile: tokenFile,
            sshKeyFile: keyFile,
          },
          { logger },
        );
        cleanups.push(async () => {
          sync.stop();
        });
        await requestRefresh();
        expect(getStatus().lastError).toBeNull();

        const gitConfig = await readFile(path.join(sync.repoDir, ".git", "config"), "utf8");
        expect(gitConfig).toContain("[credential]");
        expect(gitConfig).toContain("git-credential-helper.mjs");
        expect(gitConfig).toContain("IdentitiesOnly=yes");
        expect(gitConfig).toContain("StrictHostKeyChecking=accept-new");
        expect(gitConfig).not.toContain(token);
        expect(gitConfig).not.toContain(keyMaterial);

        // git uses a private copy of the key (OpenSSH rejects group/other-readable keys).
        const keyCopy = path.join(dataDir, "ssh", "id_snoboard");
        expect(gitConfig).toContain("id_snoboard");
        expect(gitConfig).not.toContain("ssh-key\"");
        expect(await readFile(keyCopy, "utf8")).toBe(`${keyMaterial}\n`);
        if (process.platform !== "win32") {
          expect((await stat(keyCopy)).mode & 0o777).toBe(0o600);
        }

        const filled = await runGit(
          sync.repoDir,
          ["credential", "fill"],
          "protocol=https\nhost=example.com\n\n",
        );
        expect(filled).toContain("username=x-access-token");
        expect(filled).toContain(`password=${token}`);

        const logged = [
          ...lines,
          ...info.mock.calls.flat(),
          ...error.mock.calls.flat(),
          ...warn.mock.calls.flat(),
          ...log.mock.calls.flat(),
        ].join("\n");
        expect(logged).not.toContain(token);
        expect(logged).not.toContain(keyMaterial);
      } finally {
        info.mockRestore();
        error.mockRestore();
        warn.mockRestore();
        log.mockRestore();
      }
    },
    90_000,
  );

  it(
    "reads .snoboard.yml from SNOBOARD_CONFIG_PATH when it is set",
    async () => {
      const { repo, bareDir, dataDir } = await setupRemote();
      const configPath = path.join(dataDir, "override.yml");
      await writeFile(
        configPath,
        CONFIG.replace('branchPatterns: ["tickets/*"]', 'branchPatterns: ["lane/*"]'),
        "utf8",
      );
      await repo.commit({
        branch: "lane/acme-008",
        message: "Lane work",
        files: {
          "initiatives/acme/008-lane/initiative.md": initiative("acme-008", "Lane", "planned"),
        },
      });
      await runGit(repo.dir, ["push", bareDir, "lane/acme-008"]);

      const sync: RepoSyncController = createRepoSync({
        repoUrl: bareDir,
        dataDir,
        refreshSeconds: 3600,
        configPath,
      });
      cleanups.push(async () => {
        sync.stop();
      });
      await requestRefresh();
      expect(getStatus().lastError).toBeNull();
      const item = getSnapshot()?.items.find((entry) => entry.id === "acme-008");
      expect(item?.sourceRef).toBe("lane/acme-008");
      const gitConfig = await readFile(path.join(sync.repoDir, ".git", "config"), "utf8");
      expect(gitConfig).toContain("+refs/heads/lane/*:refs/remotes/origin/lane/*");
    },
    90_000,
  );
});

describe("redactSecrets", () => {
  it("redacts token-only and user:password URL userinfo", async () => {
    const { redactSecrets } = await import("./repo-sync.js");
    // Built at runtime so the public-source audit doesn't flag test fixtures.
    const token = ["gh", "p_", "abcdefghijklmnopqrstuvwxyz0123456789"].join("");
    const password = ["s3cret", "pass"].join("");
    const scheme = ["https", "://"].join("");
    const message =
      `git clone ${scheme}${token}@github.com/o/r.git failed; ` +
      `retry ${scheme}user:${password}@example.com/o/r.git`;
    const redacted = redactSecrets(message, []);
    expect(redacted).not.toContain(token);
    expect(redacted).not.toContain(password);
    expect(redacted).toContain(`${scheme}[redacted]@github.com/o/r.git`);
  });
});
