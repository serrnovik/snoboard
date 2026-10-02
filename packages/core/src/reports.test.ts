import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { isReportFile, listInitiativeTree } from "./git.js";
import { buildSnapshot } from "./merge.js";
import { groupReports, MAX_REPORTS_PER_INITIATIVE, reportPhase } from "./reports.js";
import { createTmpRepo, type TmpRepo } from "./test-utils/tmp-repo.js";

const config = loadConfig();
const repos: TmpRepo[] = [];

afterEach(async () => {
  for (const repo of repos.splice(0)) await repo.remove();
});

function initiative(id: string): string {
  return [
    "---",
    `id: ${id}`,
    "title: Reports",
    "status: planned",
    "priority: p2",
    "updated: 2026-09-01",
    "phases:",
    "  - id: 1",
    "    title: One",
    "    status: done",
    "  - id: 2",
    "    title: Two",
    "    status: planned",
    "---",
    "",
    "## Summary",
    "",
    "Has reports.",
    "",
  ].join("\n");
}

describe("report names", () => {
  it("accepts md and html directly under reports/ or one folder deeper", () => {
    expect(isReportFile("final.report.md")).toBe(true);
    expect(isReportFile("phase-1.report.html")).toBe(true);
    expect(isReportFile("merge-review/plan.md")).toBe(true);
    expect(isReportFile("a/b/c.md")).toBe(false);
    expect(isReportFile("x.png")).toBe(false);
    expect(isReportFile("x.htm")).toBe(false);
    expect(isReportFile(".hidden.md")).toBe(false);
    expect(isReportFile("../x.md")).toBe(false);
    expect(isReportFile("a..b.md")).toBe(false);
    expect(isReportFile("sp ace.md")).toBe(false);
  });

  it("associates phase-<n> prefixes with phases", () => {
    expect(reportPhase("phase-2.report")).toBe(2);
    expect(reportPhase("phase-2.review-plan")).toBe(2);
    expect(reportPhase("phase-0-baseline/audit")).toBe(0);
    expect(reportPhase("phase-12")).toBe(12);
    expect(reportPhase("phases.report")).toBeUndefined();
    expect(reportPhase("final.report")).toBeUndefined();
    expect(reportPhase("pr63-review-test-plan")).toBeUndefined();
  });

  it("groups md/html twins and sorts naturally", () => {
    expect(
      groupReports([
        "phase-10.report.md",
        "final.report.html",
        "phase-2.report.html",
        "phase-2.report.md",
        "final.report.md",
        "notes.txt",
      ]),
    ).toEqual([
      { name: "final.report", formats: ["md", "html"] },
      { name: "phase-2.report", formats: ["md", "html"], phase: 2 },
      { name: "phase-10.report", formats: ["md"], phase: 10 },
    ]);
  });

  it("caps entries per initiative", () => {
    const files = Array.from({ length: 250 }, (_, index) => `r-${index}.md`);
    expect(groupReports(files)).toHaveLength(MAX_REPORTS_PER_INITIATIVE);
  });
});

describe("report listing", () => {
  it("lists reports from trees only and puts them on snapshot items", async () => {
    const repo = await createTmpRepo();
    repos.push(repo);
    await repo.commit({
      files: {
        "initiatives/acme/001-alpha/initiative.md": initiative("acme-001"),
        "initiatives/acme/001-alpha/reports/phase-1.report.md": "# Phase 1\n",
        "initiatives/acme/001-alpha/reports/phase-1.report.html": "<h1>Phase 1</h1>",
        "initiatives/acme/001-alpha/reports/final.report.md": "# Final\n",
        "initiatives/acme/001-alpha/reports/sub/deep.md": "# Deep\n",
        "initiatives/acme/001-alpha/reports/sub/deeper/too-deep.md": "# no\n",
        "initiatives/acme/001-alpha/reports/shot.png": "png",
        "initiatives/acme/001-alpha/notes/other.md": "# no\n",
        "initiatives/acme/002-beta/initiative.md": initiative("acme-002"),
      },
    });
    // A symlink inside reports/ is never listed.
    const target = spawnSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: repo.dir,
      encoding: "utf8",
      input: "../../../../secret.md",
    });
    expect(target.status, target.stderr).toBe(0);
    const link = spawnSync(
      "git",
      ["update-index", "--add", "--cacheinfo", `120000,${target.stdout.trim()},initiatives/acme/001-alpha/reports/link.md`],
      { cwd: repo.dir, encoding: "utf8" },
    );
    expect(link.status, link.stderr).toBe(0);
    const write = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "link"], {
      cwd: repo.dir,
      encoding: "utf8",
    });
    expect(write.status, write.stderr).toBe(0);

    const tree = await listInitiativeTree(repo.dir, "HEAD", config);
    expect(tree.files.map((file) => file.path)).toEqual([
      "initiatives/acme/001-alpha/initiative.md",
      "initiatives/acme/002-beta/initiative.md",
    ]);
    expect(tree.reports.get("initiatives/acme/001-alpha")).toEqual([
      "final.report.md",
      "phase-1.report.html",
      "phase-1.report.md",
      "sub/deep.md",
    ]);
    expect(tree.reports.has("initiatives/acme/002-beta")).toBe(false);

    const spawned: string[][] = [];
    const snapshot = await buildSnapshot(repo.dir, config, { onSpawn: (args) => spawned.push([...args]) });
    const alpha = snapshot.items.find((item) => item.id === "acme-001");
    expect(alpha?.reports).toEqual([
      { name: "final.report", formats: ["md"] },
      { name: "phase-1.report", formats: ["md", "html"], phase: 1 },
      { name: "sub/deep", formats: ["md"] },
    ]);
    expect(snapshot.items.find((item) => item.id === "acme-002")?.reports).toEqual([]);
  });
});
