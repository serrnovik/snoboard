import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { detectIconType, iconProblem, isEmojiIcon, isIconPath, parseIcon, resolveIcon } from "./icons.js";
import { parseInitiativeFile } from "./parse.js";
import { configIconIssues, validate } from "./validate.js";

const bytes = (...values: number[]) => new Uint8Array(values);
const text = (value: string) => new TextEncoder().encode(value);

describe("icon values", () => {
  it("accepts one or two emoji grapheme clusters", () => {
    for (const value of ["🧩", "🛠️", "🇫🇷", "👩‍💻", "⚡🧠", "👍🏽"]) expect(isEmojiIcon(value), value).toBe(true);
  });

  it("rejects text, three emoji and padded values", () => {
    for (const value of ["", "a", "ab", "🧩🧩🧩", " 🧩", "🧩 ", "<svg>", "1", "x🧩"]) {
      expect(isEmojiIcon(value), value).toBe(false);
    }
  });

  it("accepts repo-relative image paths and refuses traversal and other types", () => {
    expect(isIconPath("apps/web/public/favicon.svg")).toBe(true);
    expect(isIconPath("icon.png")).toBe(true);
    expect(isIconPath("a/b/c.webp")).toBe(true);
    expect(isIconPath("favicon.ico")).toBe(true);
    for (const value of [
      "../secret.png",
      "a/../b.png",
      "/etc/icon.png",
      "a//b.png",
      "./a.png",
      "a\\b.png",
      "a.gif",
      "a.jpg",
      "a.svg.txt",
      ".hidden/a.png",
      "a/%2e%2e/b.png",
      `${"a".repeat(300)}.png`,
    ]) {
      expect(isIconPath(value), value).toBe(false);
    }
  });

  it("parses emoji and paths, and explains a bad value", () => {
    expect(parseIcon("🧩")).toEqual({ kind: "emoji", value: "🧩" });
    expect(parseIcon("x/y.png")).toEqual({ kind: "image", path: "x/y.png" });
    expect(parseIcon(5)).toBeUndefined();
    expect(iconProblem("🧩")).toBeUndefined();
    expect(iconProblem("nope")).toMatch(/one or two emoji/);
    expect(iconProblem("x.png", { emojiOnly: true })).toMatch(/must be one or two emoji/);
    expect(iconProblem(3)).toBe("icon must be text");
  });

  it("falls back from the initiative icon to the project icon, then to none", () => {
    const projects = { acme: { icon: "🧩" }, bad: { icon: "nope" } };
    expect(resolveIcon({ icon: "🚀", project: "acme" }, projects)).toEqual({ kind: "emoji", value: "🚀" });
    expect(resolveIcon({ project: "acme" }, projects)).toEqual({ kind: "emoji", value: "🧩" });
    expect(resolveIcon({ icon: "not an icon", project: "acme" }, projects)).toEqual({ kind: "emoji", value: "🧩" });
    expect(resolveIcon({ project: "bad" }, projects)).toBeUndefined();
    expect(resolveIcon({ project: "other" }, projects)).toBeUndefined();
    expect(resolveIcon({ project: "acme" }, undefined)).toBeUndefined();
  });
});

describe("detectIconType", () => {
  it("knows PNG, WebP, ICO and SVG by their first bytes", () => {
    expect(detectIconType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe("image/png");
    expect(detectIconType(text("RIFF\u0000\u0000\u0000\u0000WEBPVP8 "))).toBe("image/webp");
    expect(detectIconType(bytes(0, 0, 1, 0, 1, 0, 16, 16))).toBe("image/x-icon");
    expect(detectIconType(text('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe("image/svg+xml");
    expect(detectIconType(text('<?xml version="1.0"?>\n<!-- c -->\n<svg viewBox="0 0 1 1"></svg>'))).toBe("image/svg+xml");
  });

  it("refuses HTML, GIF, JPEG and plain text", () => {
    expect(detectIconType(text("<html><svg></svg></html>"))).toBeUndefined();
    expect(detectIconType(text("GIF89a"))).toBeUndefined();
    expect(detectIconType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBeUndefined();
    expect(detectIconType(text("hello"))).toBeUndefined();
    expect(detectIconType(bytes(0, 0, 1, 0, 0, 0))).toBeUndefined();
  });
});

describe("icon validation", () => {
  it("warns (never errors) about a bad initiative icon", () => {
    const config = loadConfig();
    const file = parseInitiativeFile(
      "initiatives/acme/001-a/initiative.md",
      "---\nid: acme-001\ntitle: A\nstatus: idea\npriority: p2\nupdated: 2099-01-01\nicon: not-an-icon\n---\n",
      config,
    );
    expect(file.kind).toBe("initiative");
    const issues = validate([file], config).filter((issue) => issue.field === "icon");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe("warning");
  });

  it("accepts a good initiative icon", () => {
    const config = loadConfig();
    const file = parseInitiativeFile(
      "initiatives/acme/001-a/initiative.md",
      "---\nid: acme-001\ntitle: A\nstatus: idea\npriority: p2\nupdated: 2099-01-01\nicon: \"🚀\"\n---\n",
      config,
    );
    expect(validate([file], config).filter((issue) => issue.field === "icon")).toEqual([]);
  });

  it("warns about bad project icons, label icons that are not emoji and unknown colours", () => {
    const config = loadConfig(
      [
        "projects:",
        "  good: { icon: \"🧩\" }",
        "  path: { icon: a/b.svg }",
        "  bad: { icon: ../x.png }",
        "labels:",
        "  ok: { icon: \"💳\", color: green }",
        "  img: { icon: a.png }",
        "  hex: { color: \"#ff0000\" }",
      ].join("\n"),
    );
    const issues = configIconIssues(config);
    expect(issues.map((issue) => issue.field)).toEqual(["projects.bad.icon", "labels.img.icon", "labels.hex.color"]);
    expect(issues.every((issue) => issue.severity === "warning" && issue.path === ".snoboard.yml")).toBe(true);
    expect(validate([], config).map((issue) => issue.field)).toEqual(issues.map((issue) => issue.field));
  });
});
