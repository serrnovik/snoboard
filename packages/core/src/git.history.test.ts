import { afterEach, describe, expect, it } from "vitest";
import { folderHistory, MAX_HISTORY_COMMITS } from "./git.js";
import { createTmpRepo, type TmpRepo } from "./test-utils/tmp-repo.js";

const repos: TmpRepo[] = [];
afterEach(async () => {
  for (const repo of repos.splice(0)) await repo.remove();
});

const folder = "initiatives/acme/001-onboarding";

describe("folderHistory", () => {
  it("lists commits touching the folder, newest first, with paging", async () => {
    const repo = await createTmpRepo({
      commits: [
        { message: "create onboarding", date: "2024-01-01T00:00:00Z", files: { [`${folder}/initiative.md`]: "a\n" } },
        { message: "unrelated", date: "2024-01-02T00:00:00Z", files: { "initiatives/acme/002-x/initiative.md": "x\n" } },
        { message: "add asset", date: "2024-01-03T00:00:00Z", files: { [`${folder}/assets/a.png`]: "png" } },
        { message: "move to done", date: "2024-01-04T00:00:00Z", files: { [`${folder}/initiative.md`]: "b\n" } },
      ],
    });
    repos.push(repo);
    const spawned: string[][] = [];
    const first = await folderHistory(repo.dir, repo.defaultBranch, folder, { limit: 2 }, {
      onSpawn: (args) => spawned.push([...args]),
    });
    expect(first.commits.map((commit) => commit.subject)).toEqual(["move to done", "add asset"]);
    expect(first.hasMore).toBe(true);
    expect(first.commits[0]?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(first.commits[0]?.date.startsWith("2024-01-04")).toBe(true);
    expect(first.commits[0]?.author.length).toBeGreaterThan(0);
    expect(spawned[0]).toContain("--no-renames");
    expect(spawned[0]).not.toContain("--follow");

    const rest = await folderHistory(repo.dir, repo.defaultBranch, folder, { limit: 2, skip: 2 });
    expect(rest.commits.map((commit) => commit.subject)).toEqual(["create onboarding"]);
    expect(rest.hasMore).toBe(false);
  });

  it("rejects option-like refs and empty folders, and caps the limit", async () => {
    const repo = await createTmpRepo({
      commits: [{ message: "one", date: "2024-01-01T00:00:00Z", files: { [`${folder}/initiative.md`]: "a\n" } }],
    });
    repos.push(repo);
    await expect(folderHistory(repo.dir, "--all", folder, { limit: 5 })).rejects.toThrow();
    await expect(folderHistory(repo.dir, repo.defaultBranch, "", { limit: 5 })).rejects.toThrow();
    const spawned: string[][] = [];
    await folderHistory(repo.dir, repo.defaultBranch, folder, { limit: 10_000 }, { onSpawn: (args) => spawned.push([...args]) });
    expect(spawned[0]).toContain(`--max-count=${MAX_HISTORY_COMMITS + 1}`);
  });
});
