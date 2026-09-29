import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  fetch,
  lastCommitTouching,
  listInitiativeFiles,
  listRefs,
  readBlobs,
  type GitCallOptions,
  type GitConfig,
} from "./git.js";
import {
  fetch as exportedFetch,
  lastCommitTouching as exportedLastCommitTouching,
  listInitiativeFiles as exportedListInitiativeFiles,
  listRefs as exportedListRefs,
  readBlobs as exportedReadBlobs,
} from "./index.js";
import { addRemote, createBareClone, createTmpRepo } from "./test-utils/tmp-repo.js";

const config: GitConfig = {
  root: "initiatives",
  file: "initiative.md",
  defaultBranch: "main",
  branchPatterns: ["initiative/*"],
};

const trackedFile = "initiatives/acme/001-onboarding/initiative.md";

const mutatingCommands = new Set([
  "add",
  "checkout",
  "cherry-pick",
  "clean",
  "commit",
  "merge",
  "pull",
  "rebase",
  "reset",
  "restore",
  "stash",
  "switch",
]);

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

function gitText(repoDir: string, args: readonly string[]): string {
  const result = spawnSync("git", ["--no-pager", ...args], {
    cwd: repoDir,
    encoding: "utf8",
    windowsHide: true,
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

async function blobText(
  repoDir: string,
  ref: string,
  filePath: string,
  options?: GitCallOptions,
): Promise<string | undefined> {
  const files = await listInitiativeFiles(repoDir, ref, config, options);
  const match = files.find((file) => file.path === filePath);
  if (match === undefined) {
    return undefined;
  }
  const blobs = await readBlobs(repoDir, [match.blobSha], options);
  return blobs.get(match.blobSha);
}

describe("git reader", () => {
  it("exports the reader from the package entry", () => {
    expect(exportedListRefs).toBe(listRefs);
    expect(exportedListInitiativeFiles).toBe(listInitiativeFiles);
    expect(exportedReadBlobs).toBe(readBlobs);
    expect(exportedLastCommitTouching).toBe(lastCommitTouching);
    expect(exportedFetch).toBe(fetch);
  });

  it("does not check out or write the work tree", async () => {
    const source = await readFile(new URL("./git.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bcheckout\b/);
    expect(source).not.toMatch(/writeFile|appendFile|createWriteStream/);

    const repo = track(
      await createTmpRepo({
        commits: [
          {
            message: "main initiatives",
            date: "2024-01-01T00:00:00Z",
            files: {
              [trackedFile]: "from-main\n",
              "initiatives/readme.md": "not an initiative\n",
              "initiatives/acme/notes.md": "too shallow\n",
              "initiatives/acme/001-onboarding/notes.md": "wrong file name\n",
              "initiatives/acme/001-onboarding/extra/initiative.md": "too deep\n",
            },
          },
          {
            branch: "initiative/acme-002",
            message: "billing branch",
            date: "2024-02-01T00:00:00Z",
            files: {
              [trackedFile]: "from-branch-a\n",
              "initiatives/acme/002-billing/initiative.md": "billing-a\n",
            },
          },
          {
            branch: "initiative/nested/phase-1",
            message: "nested branch",
            date: "2024-03-01T00:00:00Z",
            files: {
              [trackedFile]: "from-branch-b\n",
            },
          },
          {
            branch: "topic/scratch",
            message: "ignored branch",
            date: "2024-04-01T00:00:00Z",
            files: {
              [trackedFile]: "from-topic\n",
            },
          },
        ],
      }),
    );

    expect(path.isAbsolute(repo.dir)).toBe(true);
    if (process.platform === "win32") {
      expect(repo.dir).toMatch(/^[A-Za-z]:\\/);
    }

    const headBefore = gitText(repo.dir, ["branch", "--show-current"]).trim();
    expect(headBefore).toBe("topic/scratch");
    const diskBefore = await readFile(path.join(repo.dir, ...trackedFile.split("/")), "utf8");
    expect(diskBefore).toBe("from-topic\n");

    const commands: string[][] = [];
    const onSpawn: GitCallOptions["onSpawn"] = (args) => {
      commands.push([...args]);
    };
    const refs = await listRefs(repo.dir, {
      defaultBranch: config.defaultBranch,
      branchPatterns: config.branchPatterns,
      onSpawn,
    });

    expect(refs.map((ref) => ref.name)).toEqual([
      "initiative/acme-002",
      "initiative/nested/phase-1",
      "main",
    ]);
    expect(refs.find((ref) => ref.name === "main")?.isDefault).toBe(true);
    expect(refs.filter((ref) => ref.name !== "main").every((ref) => !ref.isDefault)).toBe(true);
    expect(commands.map((args) => args.at(-1))).toEqual([
      "refs/remotes/origin/",
      "refs/heads/",
    ]);

    expect(await blobText(repo.dir, "main", trackedFile, { onSpawn })).toBe("from-main\n");
    expect(await blobText(repo.dir, "initiative/acme-002", trackedFile, { onSpawn })).toBe(
      "from-branch-a\n",
    );
    expect(await blobText(repo.dir, "initiative/nested/phase-1", trackedFile, { onSpawn })).toBe(
      "from-branch-b\n",
    );

    const branchFiles = await listInitiativeFiles(repo.dir, "initiative/acme-002", config, {
      onSpawn,
    });
    expect(branchFiles.map((file) => file.path)).toEqual([
      trackedFile,
      "initiatives/acme/002-billing/initiative.md",
    ]);

    const mainTouch = await lastCommitTouching(repo.dir, "main", trackedFile, { onSpawn });
    const branchTouch = await lastCommitTouching(
      repo.dir,
      "initiative/acme-002",
      trackedFile,
      { onSpawn },
    );
    expect(mainTouch.sha).toBe(repo.tips.get("main"));
    expect(branchTouch.sha).toBe(repo.tips.get("initiative/acme-002"));
    expect(Date.parse(mainTouch.date)).toBe(Date.parse("2024-01-01T00:00:00Z"));
    expect(Date.parse(branchTouch.date)).toBe(Date.parse("2024-02-01T00:00:00Z"));

    expect(gitText(repo.dir, ["branch", "--show-current"]).trim()).toBe(headBefore);
    expect(await readFile(path.join(repo.dir, ...trackedFile.split("/")), "utf8")).toBe(diskBefore);
    expect(gitText(repo.dir, ["status", "--porcelain"])).toBe("");
    for (const args of commands) {
      expect(mutatingCommands.has(args[0] ?? "")).toBe(false);
    }
  }, 30_000);

  it("reads 200 blobs with one git process", async () => {
    const expected = new Map<string, string>();
    const files: Record<string, string> = {};
    for (let index = 0; index < 200; index += 1) {
      const slug = `item-${String(index).padStart(3, "0")}`;
      const filePath = `initiatives/batch/${slug}/initiative.md`;
      let content = `content-${index}\n`;
      if (index === 0) {
        content = "line1\nline2\n";
      } else if (index === 1) {
        content = "café";
      } else if (index === 2) {
        content = "deadbeef blob 1\n";
      } else if (index === 3) {
        content = "";
      } else if (index === 199) {
        content = "end-marker\n";
      }
      files[filePath] = content;
      expected.set(filePath, content);
    }
    files["initiatives/batch/readme.md"] = "ignore\n";

    const repo = track(
      await createTmpRepo({
        commits: [{ message: "batch", files }],
      }),
    );
    const listed = await listInitiativeFiles(repo.dir, "main", config);
    expect(listed).toHaveLength(200);

    const commands: string[][] = [];
    const blobs = await readBlobs(
      repo.dir,
      listed.map((file) => file.blobSha),
      {
        onSpawn: (args) => {
          commands.push([...args]);
        },
      },
    );
    expect(commands).toEqual([["cat-file", "--batch"]]);
    expect(blobs.size).toBe(200);
    for (const file of listed) {
      expect(blobs.get(file.blobSha)).toBe(expected.get(file.path));
    }

    let emptySpawns = 0;
    const empty = await readBlobs(repo.dir, [], {
      onSpawn: () => {
        emptySpawns += 1;
      },
    });
    expect(empty.size).toBe(0);
    expect(emptySpawns).toBe(0);
  }, 60_000);

  it("fetches a partial clone and reads blobs without a work tree", async () => {
    const source = track(
      await createTmpRepo({
        commits: [
          {
            date: "2024-01-01T00:00:00Z",
            files: { [trackedFile]: "from-main\n" },
          },
          {
            branch: "initiative/acme-002",
            date: "2024-02-01T00:00:00Z",
            files: { "initiatives/acme/002-billing/initiative.md": "billing-a\n" },
          },
        ],
      }),
    );
    const bare = track(await createBareClone(source.dir));
    const mirror = track(await createTmpRepo());
    await addRemote(mirror.dir, bare.dir);
    const fetchCommands: string[][] = [];
    await fetch(mirror.dir, ["+refs/heads/*:refs/remotes/origin/*"], {
      onSpawn: (args) => {
        fetchCommands.push([...args]);
      },
    });
    expect(fetchCommands).toEqual([
      [
        "fetch",
        "--prune",
        "--filter=blob:none",
        "origin",
        "+refs/heads/*:refs/remotes/origin/*",
      ],
    ]);

    const listCommands: string[][] = [];
    const refs = await listRefs(mirror.dir, {
      defaultBranch: "main",
      branchPatterns: ["initiative/*"],
      onSpawn: (args) => {
        listCommands.push([...args]);
      },
    });
    expect(listCommands).toHaveLength(1);
    expect(listCommands[0]?.at(-1)).toBe("refs/remotes/origin/");
    expect(refs.map((ref) => [ref.name, ref.isDefault])).toEqual([
      ["initiative/acme-002", false],
      ["main", true],
    ]);

    const main = refs.find((ref) => ref.name === "main");
    expect(main).toBeDefined();
    const remoteMainSha = main?.sha ?? "";
    expect(await blobText(mirror.dir, remoteMainSha, trackedFile)).toBe("from-main\n");
    expect(await readdir(mirror.dir)).not.toContain("initiatives");
    expect(gitText(mirror.dir, ["status", "--porcelain"])).toBe("");

    await mirror.commit({
      files: { "initiatives/acme/009-local/initiative.md": "local-main\n" },
    });
    await mirror.commit({
      branch: "initiative/local-only",
      files: { "initiatives/acme/003-reports/initiative.md": "local-only\n" },
    });
    const afterLocal = await listRefs(mirror.dir, {
      defaultBranch: "main",
      branchPatterns: ["initiative/*"],
    });
    expect(afterLocal.map((ref) => ref.name)).toEqual(["initiative/acme-002", "main"]);
    expect(afterLocal.find((ref) => ref.name === "main")?.sha).toBe(remoteMainSha);
    expect(afterLocal.find((ref) => ref.name === "main")?.sha).not.toBe(mirror.tips.get("main"));
  }, 60_000);
});