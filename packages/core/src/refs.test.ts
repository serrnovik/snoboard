import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { buildSnapshot } from "./merge.js";
import { isValidBranchName, matchesBranchPatterns, MAX_BRANCH_NAME_LENGTH } from "./refs.js";
import { createTmpRepo, type TmpRepo } from "./test-utils/tmp-repo.js";

describe("isValidBranchName", () => {
  it.each(["main", "feat/a-b", "initiative/x/phase-1", "fix_1.2", "user@host"])("accepts %s", (name) => {
    expect(isValidBranchName(name)).toBe(true);
  });

  it.each([
    "",
    "-main",
    "--upload-pack=x",
    "/main",
    "main/",
    "a//b",
    "a..b",
    "../x",
    "a/./b",
    ".hidden",
    "a/.b",
    "x.lock",
    "a/x.lock/b",
    "end.",
    "a b",
    "a~1",
    "a^",
    "a:b",
    "a?",
    "a*",
    "a[b",
    "a\b",
    "a@{1}",
    "@",
    "HEAD",
    "refs/heads/main",
    "tab\tname",
    "nul\0",
    "x".repeat(MAX_BRANCH_NAME_LENGTH + 1),
  ])("refuses %j", (name) => {
    expect(isValidBranchName(name)).toBe(false);
  });

  it("refuses non-strings", () => {
    expect(isValidBranchName(undefined)).toBe(false);
    expect(isValidBranchName(["main"])).toBe(false);
  });
});

describe("matchesBranchPatterns", () => {
  it("matches globs across slashes and exact names only", () => {
    expect(matchesBranchPatterns("feat/a/b", ["feat/*"])).toBe(true);
    expect(matchesBranchPatterns("main", ["main"])).toBe(true);
    expect(matchesBranchPatterns("mainline", ["main"])).toBe(false);
    expect(matchesBranchPatterns("anything", ["*"])).toBe(true);
    expect(matchesBranchPatterns("feat.x", ["feat?x"])).toBe(true);
    expect(matchesBranchPatterns("featx", ["feat.x"])).toBe(false);
    expect(matchesBranchPatterns("x", [])).toBe(false);
  });
});

describe("buildSnapshot with explicit refs", () => {
  let repo: TmpRepo | undefined;
  afterEach(async () => {
    await repo?.remove();
    repo = undefined;
  });

  it("shows one branch alone instead of merging", async () => {
    repo = await createTmpRepo();
    const file = (status: string) =>
      ["---", "id: acme-001", "title: One", `status: ${status}`, "priority: p2", "updated: 2024-01-01", "---", "", "## Summary", "", "S", ""].join("\n");
    await repo.commit({ files: { "initiatives/acme/001-one/initiative.md": file("planned") }, date: "2024-01-01T00:00:00Z" });
    await repo.commit({
      branch: "feat/old",
      files: { "initiatives/acme/002-two/initiative.md": file("idea").replace("acme-001", "acme-002") },
      date: "2024-02-01T00:00:00Z",
    });
    await repo.commit({ files: { "initiatives/acme/001-one/initiative.md": file("done") }, date: "2024-03-01T00:00:00Z" });
    const sha = repo.tips.get("feat/old");
    if (sha === undefined) throw new Error("missing tip");
    const snapshot = await buildSnapshot(repo.dir, loadConfig(), {
      refs: [{ name: "feat/old", sha, isDefault: true }],
    });
    expect(snapshot.refs.map((ref) => ref.name)).toEqual(["feat/old"]);
    expect(snapshot.items.map((item) => [item.id, item.status, item.sourceRef])).toEqual([
      ["acme-001", "planned", "feat/old"],
      ["acme-002", "idea", "feat/old"],
    ]);
    expect(snapshot.items.every((item) => item.onBranches.length === 0)).toBe(true);
  });
});
