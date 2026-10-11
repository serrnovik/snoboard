import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isEditableDocPath, isNewDocPath } from "./documents.js";
import { MAX_DOC_EDIT_LENGTH } from "./edit-schema.js";
import { applyDocEdit, applyEdit, docHash, EditSchema, summarizeEdit } from "./edits.js";
import { loadConfig } from "./config.js";

const BOM = String.fromCharCode(0xfeff);
const CRLF = String.fromCharCode(13, 10);
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

describe("document edit paths", () => {
  it("accepts listed markdown documents and reports", () => {
    for (const path of ["ROADMAP.md", "phases/phase-1.packet.md", "phases/phase-1/T1.1-schema.md", "reports/final.report.md", "reports/review/plan.md"]) {
      expect(isEditableDocPath(path), path).toBe(true);
    }
  });

  it("refuses traversal, html, the initiative file and odd paths", () => {
    for (const path of [
      "",
      "initiative.md",
      "Initiative.md",
      "../other/initiative.md",
      "phases/../initiative.md",
      "phases/../../x.md",
      "./ROADMAP.md",
      "/ROADMAP.md",
      `phases${String.fromCharCode(92)}x.md`,
      "ROADMAP.html",
      "ROADMAP",
      "assets/a.png",
      "a/b/c/d.md",
      "reports/a/b/c.md",
      "phases/.hidden.md",
      "phases//x.md",
      `${"a".repeat(301)}.md`,
    ]) {
      expect(isEditableDocPath(path), path).toBe(false);
    }
  });

  it("only lets new documents go to the top level or phases/", () => {
    expect(isNewDocPath("phases/phase-2.packet.md")).toBe(true);
    expect(isNewDocPath("NOTES.md")).toBe(true);
    expect(isNewDocPath("phases/phase-2/T2.1-x.md")).toBe(false);
    expect(isNewDocPath("reports/x.md")).toBe(false);
    expect(isNewDocPath("other/x.md")).toBe(false);
    expect(isNewDocPath("phases/x.html")).toBe(false);
    expect(isNewDocPath("initiative.md")).toBe(false);
  });
});

describe("setDoc / createDoc schema", () => {
  const hash = "a".repeat(64);
  it("parses valid edits", () => {
    expect(EditSchema.safeParse({ kind: "setDoc", id: "acme-001", path: "ROADMAP.md", fromHash: hash, to: "x" }).success).toBe(true);
    expect(EditSchema.safeParse({ kind: "createDoc", id: "acme-001", path: "phases/phase-1.packet.md", to: "x" }).success).toBe(true);
  });

  it("rejects bad paths, hashes and oversized text", () => {
    const base = { kind: "setDoc", id: "acme-001", path: "ROADMAP.md", fromHash: hash, to: "x" };
    expect(EditSchema.safeParse({ ...base, path: "initiative.md" }).success).toBe(false);
    expect(EditSchema.safeParse({ ...base, path: "../x.md" }).success).toBe(false);
    expect(EditSchema.safeParse({ ...base, path: "ROADMAP.html" }).success).toBe(false);
    expect(EditSchema.safeParse({ ...base, fromHash: "nope" }).success).toBe(false);
    expect(EditSchema.safeParse({ ...base, to: "x".repeat(MAX_DOC_EDIT_LENGTH + 1) }).success).toBe(false);
    expect(EditSchema.safeParse({ kind: "createDoc", id: "acme-001", path: "phases/phase-1/T1.md", to: "" }).success).toBe(false);
  });

  it("summarizes as doc <path>", () => {
    expect(summarizeEdit({ kind: "setDoc", id: "acme-001", path: "ROADMAP.md", fromHash: hash, to: "x" })).toBe("acme-001: doc ROADMAP.md");
    expect(summarizeEdit({ kind: "createDoc", id: "acme-001", path: "phases/phase-1.packet.md", to: "x" })).toBe(
      "acme-001: new doc phases/phase-1.packet.md",
    );
  });

  it("never applies to the initiative file", () => {
    const result = applyEdit("---\nid: acme-001\n---\n", { kind: "setDoc", id: "acme-001", path: "ROADMAP.md", fromHash: hash, to: "x" }, loadConfig(), "2026-10-01");
    expect(result).toEqual({ error: "setDoc does not change the initiative file" });
  });
});

describe("applyDocEdit", () => {
  it("replaces the text when the hash matches", () => {
    const current = "# Roadmap\n\nOld\n";
    expect(docHash(current)).toBe(sha(current));
    const result = applyDocEdit(current, { kind: "setDoc", id: "acme-001", path: "ROADMAP.md", fromHash: docHash(current), to: "# Roadmap\n\nNew\n" });
    expect(result).toEqual({ text: "# Roadmap\n\nNew\n" });
  });

  it("rejects a stale hash", () => {
    const result = applyDocEdit("changed meanwhile\n", { kind: "setDoc", id: "acme-001", path: "ROADMAP.md", fromHash: sha("old\n"), to: "new" });
    expect(result).toEqual({ error: "stale" });
  });

  it("keeps the byte-order mark and CRLF line endings", () => {
    const current = `${BOM}# A${CRLF}${CRLF}b${CRLF}`;
    const result = applyDocEdit(current, { kind: "setDoc", id: "acme-001", path: "ROADMAP.md", fromHash: docHash(current), to: "# A\n\nc\n" });
    expect(result).toEqual({ text: `${BOM}# A${CRLF}${CRLF}c${CRLF}` });
  });

  it("refuses documents larger than the edit limit with a clear message", () => {
    const current = "x".repeat(MAX_DOC_EDIT_LENGTH + 1);
    const result = applyDocEdit(current, { kind: "setDoc", id: "acme-001", path: "ROADMAP.md", fromHash: docHash(current), to: "x" });
    expect(result).toEqual({ error: `ROADMAP.md is too large to edit in the board (over ${MAX_DOC_EDIT_LENGTH} characters)` });
  });

  it("needs the file for setDoc and its absence for createDoc", () => {
    expect(applyDocEdit(undefined, { kind: "setDoc", id: "acme-001", path: "ROADMAP.md", fromHash: sha(""), to: "x" })).toEqual({
      error: "ROADMAP.md was not found",
    });
    expect(applyDocEdit("", { kind: "createDoc", id: "acme-001", path: "NOTES.md", to: "x" })).toEqual({ error: "NOTES.md already exists" });
    expect(applyDocEdit(undefined, { kind: "createDoc", id: "acme-001", path: "NOTES.md", to: `a${CRLF}b` })).toEqual({ text: "a\nb\n" });
  });
});
