import { describe, expect, it } from "vitest";
import {
  detectImageType,
  MAX_ATTACHMENT_BYTES,
  safeAssetBaseName,
  uniqueAssetPath,
} from "./attachments.js";
import { loadConfig } from "./config.js";
import { applyEdit, EditSchema, summarizeEdit, type Edit } from "./edits.js";
import { isSafeLinkUrl, linkProblem } from "./links.js";
import { parseInitiativeFile } from "./parse.js";
import { validate } from "./validate.js";

const config = loadConfig();
const TODAY = "2026-10-01";
const PATH = "initiatives/acme/001-alpha/initiative.md";

function file(extra: string): string {
  return `---\nid: acme-001\ntitle: Alpha\nstatus: idea\npriority: p2\nupdated: 2026-09-30\n${extra}---\n\n# Alpha\n`;
}

function errorsOf(text: string): string[] {
  const parsed = parseInitiativeFile(PATH, text, config);
  expect(parsed.kind).toBe("initiative");
  return validate([parsed], config)
    .filter((issue) => issue.severity === "error")
    .map((issue) => `${issue.field}: ${issue.message}`);
}

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));
const PNG = Uint8Array.from([0x89, ...ascii("PNG"), 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const GIF = Uint8Array.from(ascii("GIF89a......"));
const WEBP = Uint8Array.from([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBPVP8 ")]);
const SVG = Uint8Array.from(ascii('<svg xmlns="http://www.w3.org/2000/svg"></svg>'));

describe("links", () => {
  it("accepts https and mailto only", () => {
    expect(isSafeLinkUrl("https://example.com/a?b=c")).toBe(true);
    expect(isSafeLinkUrl("mailto:team@example.com")).toBe(true);
    for (const bad of [
      "http://example.com",
      "javascript:alert(1)",
      "data:text/html,x",
      "//example.com",
      "https:example.com",
      "https://exa mple.com",
      `https://example.com/${"a".repeat(2048)}`,
      "",
    ]) {
      expect(isSafeLinkUrl(bad), bad).toBe(false);
    }
  });

  it("checks titles", () => {
    expect(linkProblem({ title: "Spec", url: "https://example.com" })).toBeUndefined();
    expect(linkProblem({ title: " ", url: "https://example.com" })).toMatch(/empty/);
    expect(linkProblem({ title: "x".repeat(121), url: "https://example.com" })).toMatch(/120/);
  });

  it("validates links in frontmatter as errors", () => {
    expect(errorsOf(file("links:\n  - title: Spec\n    url: https://example.com/spec\n"))).toEqual([]);
    expect(errorsOf(file("links:\n  - title: Bad\n    url: javascript:alert(1)\n"))).toEqual([
      "links: link 1: url must be an https: or mailto: address",
    ]);
    const many = Array.from({ length: 21 }, (_, index) => `  - title: L${index}\n    url: https://example.com/${index}\n`);
    expect(errorsOf(file(`links:\n${many.join("")}`))).toEqual(["links: 21 links; at most 20 are allowed"]);
  });

  it("setLinks rewrites the list, rejects stale and unsafe values", () => {
    const text = file("links:\n  - title: Old\n    url: https://example.com/old\n");
    const edit: Edit = {
      kind: "setLinks",
      id: "acme-001",
      from: [{ title: "Old", url: "https://example.com/old" }],
      to: [
        { title: "Spec: v2", url: "https://example.com/spec" },
        { title: "Mail", url: "mailto:a@example.com" },
      ],
    };
    const result = applyEdit(text, edit, config, TODAY);
    if ("error" in result) throw new Error(result.error);
    const parsed = parseInitiativeFile(PATH, result.text, config);
    expect(parsed.kind === "initiative" ? parsed.frontmatter.links : undefined).toEqual(edit.to);
    expect(result.text).toContain("updated: 2026-10-01");
    expect(applyEdit(text, { ...edit, from: [] }, config, TODAY)).toEqual({ error: "stale" });
    const cleared = applyEdit(text, { ...edit, to: [] }, config, TODAY);
    expect("text" in cleared && cleared.text.includes("links")).toBe(false);
    expect(EditSchema.safeParse({ ...edit, to: [{ title: "x", url: "http://example.com" }] }).success).toBe(false);
    expect(summarizeEdit(edit)).toBe("acme-001: links 1 link -> 2 links");
  });
});

describe("issues", () => {
  it("setIssues validates refs with the parser and caps the list at 30", () => {
    const base = { kind: "setIssues", id: "acme-001", from: [] };
    expect(EditSchema.safeParse({ ...base, to: ["gh#12", "gh:owner/name#3", "vikunja:45"] }).success).toBe(true);
    expect(EditSchema.safeParse({ ...base, to: ["gh#0"] }).success).toBe(false);
    expect(EditSchema.safeParse({ ...base, to: ["not a ref"] }).success).toBe(false);
    const many = Array.from({ length: 31 }, (_, index) => `gh#${index + 1}`);
    expect(EditSchema.safeParse({ ...base, to: many }).success).toBe(false);
  });

  it("setIssues replaces the list and refuses stale or duplicate refs", () => {
    const text = file("issues:\n  - gh#1\n");
    const edit: Edit = { kind: "setIssues", id: "acme-001", from: ["gh#1"], to: ["gh#1", "vikunja:45"] };
    const result = applyEdit(text, edit, config, TODAY);
    if ("error" in result) throw new Error(result.error);
    expect(result.text).toContain("issues:\n  - gh#1\n  - vikunja:45\n");
    expect(applyEdit(text, { ...edit, from: [] }, config, TODAY)).toEqual({ error: "stale" });
    expect(applyEdit(text, { ...edit, to: ["gh#1", "gh#1"] }, config, TODAY)).toEqual({
      error: "duplicate issue ref",
    });
    expect(summarizeEdit(edit)).toBe("acme-001: issues gh#1 -> gh#1, vikunja:45");
  });

  it("reports more than 30 refs as an error", () => {
    const refs = Array.from({ length: 31 }, (_, index) => `  - gh#${index + 1}\n`).join("");
    expect(errorsOf(file(`issues:\n${refs}`))).toEqual(["issues: 31 issue refs; at most 30 are allowed"]);
  });
});

describe("attachments", () => {
  it("detects image types from magic bytes, never SVG", () => {
    expect(detectImageType(PNG)).toBe("image/png");
    expect(detectImageType(JPEG)).toBe("image/jpeg");
    expect(detectImageType(GIF)).toBe("image/gif");
    expect(detectImageType(WEBP)).toBe("image/webp");
    expect(detectImageType(SVG)).toBeUndefined();
    expect(detectImageType(new Uint8Array())).toBeUndefined();
  });

  it("builds safe, unique asset names", () => {
    expect(safeAssetBaseName("Screen Shot 2026-10-01 at 10.00.png")).toBe("screen-shot-2026-10-01-at-10-00");
    expect(safeAssetBaseName("../../etc/passwd")).toBe("etc-passwd");
    expect(safeAssetBaseName("Ünïcødé.JPG")).toBe("unic-de");
    expect(safeAssetBaseName("....")).toBe("image");
    const taken = new Set(["assets/shot.png", "assets/shot-2.png"]);
    expect(uniqueAssetPath("shot.png", "image/png", taken)).toBe("assets/shot-3.png");
    expect(uniqueAssetPath("shot", "image/jpeg", taken)).toBe("assets/shot.jpg");
  });

  it("addAttachment checks path, type, size and target", () => {
    const edit = {
      kind: "addAttachment",
      id: "acme-001",
      path: "assets/shot.png",
      contentType: "image/png",
      sha256: "a".repeat(64),
      size: 10,
    };
    expect(EditSchema.safeParse(edit).success).toBe(true);
    expect(EditSchema.safeParse({ ...edit, id: "new:acme/my-thing" }).success).toBe(true);
    for (const bad of [
      { path: "assets/../x.png" },
      { path: "../assets/x.png" },
      { path: "assets/x.svg" },
      { path: "assets/Shot.png" },
      { path: "assets/shot.jpg" },
      { contentType: "image/svg+xml", path: "assets/x.svg" },
      { size: MAX_ATTACHMENT_BYTES + 1 },
      { size: 0 },
      { id: "new:acme/../x" },
      { sha256: "xyz" },
    ]) {
      expect(EditSchema.safeParse({ ...edit, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
    expect(summarizeEdit(EditSchema.parse(edit))).toBe("acme-001: attach assets/shot.png (10 B)");
    expect(applyEdit(file(""), EditSchema.parse(edit), config, TODAY)).toEqual({
      error: "addAttachment does not change the initiative file",
    });
  });
});
