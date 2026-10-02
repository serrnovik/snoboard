import { afterEach, describe, expect, it } from "vitest";
import { commitsUnder } from "./git-commits.js";
import { botPatterns, humansOf, isBotAuthor, loginFromEmail, parseTrailers, peopleByFolder, type PeopleCommit } from "./people.js";
import { createTmpRepo, type TmpRepo } from "./test-utils/tmp-repo.js";

const patterns = botPatterns();
const folder = "initiatives/acme/001-onboarding";

function commit(partial: Partial<PeopleCommit>): PeopleCommit {
  return { date: "2024-01-01T00:00:00Z", authorName: "Ann", authorEmail: "ann@example.com", body: "", files: [], ...partial };
}

describe("bot exclusion", () => {
  it.each([
    ["dependabot[bot]", "49699333+dependabot[bot]@users.noreply.github.com"],
    ["Claude", "noreply@anthropic.com"],
    ["Cursor Agent", "cursoragent@cursor.com"],
    ["Woodpecker CI", "ci@example.com"],
    ["github-actions", "actions@github.com"],
    ["Snapshot Publisher", "pub@example.com"],
  ])("treats %s as a bot", (name, email) => {
    expect(isBotAuthor(name, email, patterns)).toBe(true);
  });

  it("keeps humans and merges SNOBOARD_BOT_AUTHORS extras", () => {
    expect(isBotAuthor("Ann Lee", "ann@example.com", patterns)).toBe(false);
    const extended = botPatterns(" Release Robot , ");
    expect(isBotAuthor("Release Robot", "r@example.com", extended)).toBe(true);
    expect(extended).toContain("[bot]");
  });
});

describe("trailers", () => {
  it("credits Snoboard-Edit-By logins and human co-authors, not agent co-authors", () => {
    const body = [
      "feat: edit from the board",
      "",
      "Snoboard-Edit-By: serrnovik (via board)",
      "Co-Authored-By: Bob Stone <bob@example.com>",
      "Co-Authored-By: Claude Opus <noreply@anthropic.com>",
    ].join("\n");
    expect(parseTrailers(body).editBy).toEqual(["serrnovik"]);
    const people = humansOf({ authorName: "snoboard[bot]", authorEmail: "bot@example.com", body }, patterns);
    expect(people.map((person) => person.name)).toEqual(["serrnovik", "Bob Stone"]);
    expect(people[0]?.login).toBe("serrnovik");
  });

  it("reads logins from GitHub noreply emails", () => {
    expect(loginFromEmail("123+octo-cat@users.noreply.github.com")).toBe("octo-cat");
    expect(loginFromEmail("ann@example.com")).toBeUndefined();
  });
});

describe("peopleByFolder", () => {
  it("finds the creator, dedupes participants and maps asset paths to their initiative", () => {
    const commits: PeopleCommit[] = [
      commit({ authorName: "ann", authorEmail: "ANN@example.com", files: [{ status: "A", path: `${folder}/assets/x.png` }] }),
      commit({
        authorName: "Snoboard Bot",
        authorEmail: "41898282+github-actions[bot]@users.noreply.github.com",
        body: "Snoboard-Edit-By: octo (board)",
        files: [{ status: "M", path: `${folder}/initiative.md` }],
      }),
      commit({ authorName: "Ann", authorEmail: "ann@example.com", files: [{ status: "M", path: `${folder}/initiative.md` }] }),
      commit({
        date: "2023-12-01T00:00:00Z",
        authorName: "Claude",
        authorEmail: "noreply@anthropic.com",
        body: "Co-Authored-By: Dee Ray <dee@example.com>",
        files: [{ status: "A", path: `${folder}/initiative.md` }],
      }),
    ];
    const people = peopleByFolder(commits, "initiative.md", patterns).get(folder);
    expect(people?.creator?.name).toBe("Dee Ray");
    expect(people?.creator?.date).toBe("2023-12-01T00:00:00Z");
    expect(people?.participants.map((person) => person.name)).toEqual(["ann", "octo", "Dee Ray"]);
  });

  it("reads commit metadata from a real repo", async () => {
    const repo: TmpRepo = await createTmpRepo({
      commits: [
        { message: "create", date: "2024-01-01T00:00:00Z", files: { [`${folder}/initiative.md`]: "a\n" } },
        {
          message: "edit\n\nSnoboard-Edit-By: octo (board)",
          date: "2024-01-02T00:00:00Z",
          files: { [`${folder}/initiative.md`]: "b\n" },
        },
      ],
    });
    repos.push(repo);
    const spawned: string[][] = [];
    const commits = await commitsUnder(repo.dir, repo.defaultBranch, "initiatives", 100, {
      onSpawn: (args) => spawned.push([...args]),
    });
    expect(commits).toHaveLength(2);
    expect(commits[1]?.files).toEqual([{ status: "A", path: `${folder}/initiative.md` }]);
    expect(spawned[0]).toContain("--no-renames");
    const people = peopleByFolder(commits, "initiative.md", patterns).get(folder);
    expect(people?.participants.some((person) => person.login === "octo")).toBe(true);
    expect(people?.creator).not.toBeNull();
  });
});

const repos: TmpRepo[] = [];
afterEach(async () => {
  for (const repo of repos.splice(0)) await repo.remove();
});
