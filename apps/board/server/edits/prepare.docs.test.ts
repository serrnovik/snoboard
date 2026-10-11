import { buildGraph, docHash, loadConfig, MAX_DOC_EDIT_LENGTH, type BoardItem, type Snapshot } from "snoboard";
import { describe, expect, it } from "vitest";
import { prepareEdits, type ReadBlob } from "./prepare.js";

const TODAY = "2026-10-01";
const config = loadConfig();
const FOLDER = "initiatives/acme/001-alpha";
const INITIATIVE = `---
id: acme-001
title: Alpha
status: idea
priority: p2
updated: 2026-09-01
---

# Alpha
`;
const ROADMAP = "# Roadmap\n\nOld plan.\n";
const PACKET = "# Phase 1 packet\n";
const REPORT = "# Final\n";

function item(): BoardItem {
  return {
    id: "acme-001",
    title: "Alpha",
    status: "idea",
    priority: "p2",
    depends_on: [],
    updated: "2026-09-01",
    summary: "",
    path: `${FOLDER}/initiative.md`,
    project: "acme",
    number: "001",
    sourceRef: "main",
    sourceSha: "a".repeat(40),
    updatedAt: "2026-09-01T00:00:00.000Z",
    isReady: true,
    blockedBy: [],
    onBranches: [],
    phases: [{ id: 1, title: "Design", status: "idea" }],
    docs: [
      { path: "ROADMAP", kind: "initiative-doc", formats: ["md", "html"], title: "ROADMAP" },
      { path: "phases/phase-1.packet", kind: "phase-doc", formats: ["md"], title: "phase-1.packet", phase: 1 },
      { path: "VISUAL", kind: "initiative-doc", formats: ["html"], title: "VISUAL" },
    ],
    reports: [{ name: "final.report", formats: ["md"] }],
  };
}

function snapshot(): Snapshot {
  const entry = item();
  return {
    generatedAt: "2026-10-01T00:00:00.000Z",
    refs: [{ name: "main", sha: "a".repeat(40), isDefault: true }],
    items: [entry],
    legacy: [],
    errors: [],
    graph: buildGraph([{ id: entry.id, status: entry.status, depends_on: [] }], config),
  };
}

const FILES: Record<string, string> = {
  [`${FOLDER}/initiative.md`]: INITIATIVE,
  [`${FOLDER}/ROADMAP.md`]: ROADMAP,
  [`${FOLDER}/phases/phase-1.packet.md`]: PACKET,
  [`${FOLDER}/reports/final.report.md`]: REPORT,
  [`${FOLDER}/VISUAL.html`]: "<p>x</p>",
};

function reader(files: Readonly<Record<string, string>> = FILES): { read: ReadBlob; paths: string[] } {
  const paths: string[] = [];
  return {
    paths,
    read: async (_ref, filePath) => {
      paths.push(filePath);
      const text = files[filePath];
      return text === undefined ? undefined : { sha: `blob-${filePath}`, text };
    },
  };
}

const setDoc = (path: string, to: string, fromHash = docHash(ROADMAP)) => ({ kind: "setDoc", id: "acme-001", path, fromHash, to });

describe("prepareEdits: setDoc", () => {
  it("writes a listed document next to an initiative edit", async () => {
    const { read } = reader();
    const result = await prepareEdits(
      [setDoc("ROADMAP.md", "# Roadmap\n\nNew plan.\n"), { kind: "setStatus", id: "acme-001", from: "idea", to: "planned" }],
      snapshot(),
      read,
      config,
      TODAY,
    );
    expect(result.results.map((entry) => entry.ok)).toEqual([true, true]);
    const roadmap = result.files.find((file) => file.path === `${FOLDER}/ROADMAP.md`);
    expect(roadmap).toEqual({ path: `${FOLDER}/ROADMAP.md`, baseSha: `blob-${FOLDER}/ROADMAP.md`, text: "# Roadmap\n\nNew plan.\n", doc: true });
    expect(result.files.find((file) => file.path === `${FOLDER}/initiative.md`)?.text).toContain("status: planned");
  });

  it("edits phase packets and markdown reports", async () => {
    const { read } = reader();
    const result = await prepareEdits(
      [setDoc("phases/phase-1.packet.md", "# P\n", docHash(PACKET)), setDoc("reports/final.report.md", "# R\n", docHash(REPORT))],
      snapshot(),
      read,
      config,
      TODAY,
    );
    expect(result.results.every((entry) => entry.ok)).toBe(true);
    expect(result.files.map((file) => file.path).sort()).toEqual([
      `${FOLDER}/phases/phase-1.packet.md`,
      `${FOLDER}/reports/final.report.md`,
    ]);
  });

  it("rejects a stale hash", async () => {
    const { read } = reader({ ...FILES, [`${FOLDER}/ROADMAP.md`]: "# Roadmap\n\nChanged meanwhile.\n" });
    const result = await prepareEdits([setDoc("ROADMAP.md", "mine")], snapshot(), read, config, TODAY);
    expect(result.results[0]).toMatchObject({ ok: false, error: "acme-001: stale" });
    expect(result.files).toEqual([]);
  });

  it("refuses documents the snapshot does not list, html twins and the initiative file", async () => {
    const { read, paths } = reader({ ...FILES, [`${FOLDER}/SECRET.md`]: "x" });
    const result = await prepareEdits(
      [
        setDoc("SECRET.md", "y"),
        setDoc("VISUAL.md", "y"),
        setDoc("VISUAL.html", "y"),
        setDoc("initiative.md", "y"),
        setDoc("../002-beta/ROADMAP.md", "y"),
        setDoc("phases/../initiative.md", "y"),
      ],
      snapshot(),
      read,
      config,
      TODAY,
    );
    expect(result.results.map((entry) => entry.ok)).toEqual([false, false, false, false, false, false]);
    expect(result.results[0]?.error).toBe("acme-001: SECRET.md is not a listed document");
    expect(result.results[1]?.error).toBe("acme-001: VISUAL.md is not a listed document");
    expect(result.results[2]?.error).toMatch(/^path: /);
    expect(result.results[3]?.error).toMatch(/^path: /);
    expect(result.results[4]?.error).toMatch(/^path: /);
    expect(result.results[5]?.error).toMatch(/^path: /);
    expect(paths).toEqual([]);
    expect(result.files).toEqual([]);
  });

  it("refuses documents over the edit limit with a clear message", async () => {
    const big = "x".repeat(MAX_DOC_EDIT_LENGTH + 1);
    const { read } = reader({ ...FILES, [`${FOLDER}/ROADMAP.md`]: big });
    const result = await prepareEdits([setDoc("ROADMAP.md", "y", docHash(big))], snapshot(), read, config, TODAY);
    expect(result.results[0]?.error).toBe(
      `acme-001: ROADMAP.md is too large to edit in the board (over ${MAX_DOC_EDIT_LENGTH} characters)`,
    );
  });

  it("refuses unknown initiatives", async () => {
    const { read } = reader();
    const result = await prepareEdits([{ ...setDoc("ROADMAP.md", "y"), id: "acme-404" }], snapshot(), read, config, TODAY);
    expect(result.results[0]).toMatchObject({ ok: false, error: "unknown initiative acme-404" });
  });
});

describe("prepareEdits: createDoc", () => {
  const createDoc = (path: string, to = "# New\n") => ({ kind: "createDoc", id: "acme-001", path, to });

  it("adds a new phase document", async () => {
    const { read } = reader();
    const result = await prepareEdits([createDoc("phases/phase-2.packet.md", "# Phase 2")], snapshot(), read, config, TODAY);
    expect(result.results[0]?.ok).toBe(true);
    expect(result.files).toEqual([{ path: `${FOLDER}/phases/phase-2.packet.md`, baseSha: null, text: "# Phase 2\n", doc: true }]);
  });

  it("refuses listed, existing and misplaced documents", async () => {
    const { read } = reader({ ...FILES, [`${FOLDER}/NOTES.md`]: "already here" });
    const result = await prepareEdits(
      [createDoc("ROADMAP.md"), createDoc("NOTES.md"), createDoc("phases/phase-1/T1.1-x.md"), createDoc("initiative.md")],
      snapshot(),
      read,
      config,
      TODAY,
    );
    expect(result.results.map((entry) => entry.ok)).toEqual([false, false, false, false]);
    expect(result.results[0]?.error).toBe("acme-001: ROADMAP.md already exists");
    expect(result.results[1]?.error).toBe("acme-001: NOTES.md already exists");
    expect(result.files).toEqual([]);
  });

  it("refuses the same new document twice in one batch", async () => {
    const { read } = reader();
    const result = await prepareEdits([createDoc("NOTES.md"), createDoc("NOTES.md")], snapshot(), read, config, TODAY);
    expect(result.results.map((entry) => entry.ok)).toEqual([true, false]);
  });
});
