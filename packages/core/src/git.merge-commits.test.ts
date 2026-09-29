import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { lastCommitsForPaths } from "./git.js";
import { createTmpRepo, type TmpRepo } from "./test-utils/tmp-repo.js";

let repo: TmpRepo | undefined;
afterEach(async () => {
  await repo?.remove();
  repo = undefined;
});

describe("lastCommitsForPaths with merge commits", () => {
  it("attributes files that arrived through a merge to the merge commit", async () => {
    repo = await createTmpRepo({
      commits: [{ files: { "initiatives/acme/001-a/initiative.md": "# A\n" } }],
    });
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo!.dir, encoding: "utf8" }).trim();
    git("checkout", "-q", "-b", "feature");
    await repo.commit({
      branch: "feature",
      files: { "initiatives/acme/002-b/initiative.md": "# B\n" },
    });
    git("checkout", "-q", "main");
    await repo.commit({ files: { "README.md": "x\n" } });
    git("merge", "-q", "--no-ff", "-m", "merge feature", "feature");
    const mergeSha = git("rev-parse", "HEAD");

    const touches = await lastCommitsForPaths(repo.dir, mergeSha, "initiatives");

    expect(touches.get("initiatives/acme/002-b/initiative.md")?.sha).toBe(mergeSha);
    expect(touches.has("initiatives/acme/001-a/initiative.md")).toBe(true);
  });

  it("keeps non-ASCII paths unquoted", async () => {
    repo = await createTmpRepo({
      commits: [{ files: { "initiatives/acme/003-café/initiative.md": "# C\n" } }],
    });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo.dir, encoding: "utf8" }).trim();
    const touches = await lastCommitsForPaths(repo.dir, head, "initiatives");
    expect(touches.has("initiatives/acme/003-café/initiative.md")).toBe(true);
  });
});
