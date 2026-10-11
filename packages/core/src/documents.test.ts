import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { classifyDoc, groupDocs, isDocFile, MAX_DOCS_PER_INITIATIVE } from "./documents.js";
import { listInitiativeTree } from "./git.js";
import { buildSnapshot } from "./merge.js";
import { createTmpRepo, type TmpRepo } from "./test-utils/tmp-repo.js";

const config = loadConfig();
const repos: TmpRepo[] = [];

afterEach(async () => {
  for (const repo of repos.splice(0)) await repo.remove();
});

describe("document names", () => {
  it("accepts md and html up to three segments, outside reports/", () => {
    expect(isDocFile("ROADMAP.md")).toBe(true);
    expect(isDocFile("phases/phase-1.packet.md")).toBe(true);
    expect(isDocFile("phases/phase-1/T1.2-schema.md")).toBe(true);
    expect(isDocFile("phases/phase-1/sub/deep.md")).toBe(false);
    expect(isDocFile("reports/final.report.md")).toBe(false);
    expect(isDocFile("reports.md")).toBe(true);
    expect(isDocFile("x.png")).toBe(false);
    expect(isDocFile("../x.md")).toBe(false);
    expect(isDocFile("phases/.hidden.md")).toBe(false);
    expect(isDocFile("sp ace.md")).toBe(false);
  });
});

describe("document classification", () => {
  it.each([
    ["phases/phase-1.packet", "phase-doc", 1],
    ["phases/phase-12.packet", "phase-doc", 12],
    ["phases/phase-2a.packet", "phase-doc", 2],
    ["phases/phase-2b.packet", "phase-doc", 2],
    ["phases/phase-3.1.packet", "phase-doc", 3],
    ["phases/phase-4-rollout.packet", "phase-doc", 4],
    ["phases/phase-5.prompt", "phase-doc", 5],
    ["phases/00-investigation", "phase-doc", 0],
    ["phases/03-build", "phase-doc", 3],
    ["phases/README", "phase-doc", undefined],
    ["phases/execute.prompt", "phase-doc", undefined],
    ["phases/phase-1/T1.2-schema", "task", 1],
    ["phases/phase-10/T10.1-api", "task", 10],
    ["phases/02-build/T2.1-x", "task", 2],
    ["phases/misc/notes", "phase-doc", undefined],
    ["ROADMAP", "initiative-doc", undefined],
    ["CONVENTIONS", "initiative-doc", undefined],
    ["SETUP", "initiative-doc", undefined],
    ["01-notes", "initiative-doc", undefined],
    ["phase-2.notes", "phase-doc", 2],
    ["design/api", "initiative-doc", undefined],
    ["phase-3/review", "phase-doc", 3],
  ])("%s -> %s %s", (path, kind, phase) => {
    expect(classifyDoc(path)).toEqual(phase === undefined ? { kind } : { kind, phase });
  });

  it("groups twins, skips the initiative file, sorts naturally and titles from the file name", () => {
    expect(
      groupDocs([
        "initiative.md",
        "ROADMAP.md",
        "phases/phase-10.packet.md",
        "phases/phase-2.packet.md",
        "phases/phase-2.packet.html",
        "phases/phase-1/T1.1-a.md",
        "notes.txt",
      ]),
    ).toEqual([
      { path: "phases/phase-1/T1.1-a", kind: "task", formats: ["md"], title: "T1.1-a", phase: 1 },
      { path: "phases/phase-2.packet", kind: "phase-doc", formats: ["md", "html"], title: "phase-2.packet", phase: 2 },
      { path: "phases/phase-10.packet", kind: "phase-doc", formats: ["md"], title: "phase-10.packet", phase: 10 },
      { path: "ROADMAP", kind: "initiative-doc", formats: ["md"], title: "ROADMAP" },
    ]);
  });

  it("caps entries per initiative", () => {
    const files = Array.from({ length: 400 }, (_, index) => `d-${index}.md`);
    expect(groupDocs(files)).toHaveLength(MAX_DOCS_PER_INITIATIVE);
  });
});

describe("document listing", () => {
  it("lists documents from trees only and puts them on snapshot items", async () => {
    const repo = await createTmpRepo();
    repos.push(repo);
    await repo.commit({
      files: {
        "initiatives/acme/001-alpha/initiative.md": [
          "---",
          "id: acme-001",
          "title: Docs",
          "status: planned",
          "priority: p2",
          "updated: 2026-09-01",
          "---",
          "",
          "## Summary",
          "",
          "Has docs.",
          "",
        ].join("\n"),
        "initiatives/acme/001-alpha/ROADMAP.md": "# Roadmap\n",
        "initiatives/acme/001-alpha/phases/phase-1.packet.md": "# P1\n",
        "initiatives/acme/001-alpha/phases/phase-1/T1.1-x.md": "# T\n",
        "initiatives/acme/001-alpha/phases/phase-1/deep/too-deep.md": "# no\n",
        "initiatives/acme/001-alpha/reports/final.report.md": "# Final\n",
        "initiatives/acme/001-alpha/assets/shot.png": "png",
      },
    });
    const tree = await listInitiativeTree(repo.dir, "HEAD", config);
    expect(tree.docs.get("initiatives/acme/001-alpha")).toEqual([
      "ROADMAP.md",
      "phases/phase-1.packet.md",
      "phases/phase-1/T1.1-x.md",
    ]);
    const spawned: string[][] = [];
    const snapshot = await buildSnapshot(repo.dir, config, { onSpawn: (args) => spawned.push([...args]) });
    const alpha = snapshot.items.find((item) => item.id === "acme-001");
    expect(alpha?.docs?.map((doc) => doc.path)).toEqual(["phases/phase-1.packet", "phases/phase-1/T1.1-x", "ROADMAP"]);
    expect(alpha?.reports?.map((report) => report.name)).toEqual(["final.report"]);
    // Only the initiative file blob is read; documents come from the tree listing.
    expect(spawned.some((args) => args.includes("phases/phase-1.packet.md"))).toBe(false);
  });
});
