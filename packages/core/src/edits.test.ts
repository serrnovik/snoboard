import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import {
  applyEdit,
  bodyHash,
  EditSchema,
  renderNewInitiative,
  summarizeEdit,
  type Edit,
} from "./edits.js";
import { MAX_INITIATIVE_BODY_LENGTH } from "./edit-schema.js";
import { parseInitiativeFile } from "./parse.js";
import { validate } from "./validate.js";

const config = loadConfig();
const TODAY = "2026-10-01";
const NL = String.fromCharCode(10);
const PROSE = "\n# Alpha\n\n## Summary\n\nKeep this byte-for-byte.  \n";
const BASE = `# file note
id: acme-001 # id note
title: Alpha
status: idea # status note
priority: p2
updated: 2026-09-01 # touched
labels: # labels note
  - alpha
  - beta
phases:
  - id: 1
    title: Foundations
    status: planned # phase note
  - id: 2
    title: Ship
    status: idea
vikunja:
  board: alpha
`;

function initiative(yaml: string, prose = PROSE, newline: "\n" | "\r\n" = "\n"): string {
  const body = yaml.replaceAll("\n", newline);
  const tail = prose.replaceAll("\n", newline);
  return `---${newline}${body}---${newline}${tail}`;
}

function bodyOf(text: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (match === null) throw new Error("frontmatter was not closed");
  return match[1] ?? "";
}

function frontOf(text: string): string {
  const match = /^(---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$))/.exec(text);
  if (match === null) throw new Error("frontmatter was not closed");
  return match[1] ?? "";
}

function applied(text: string, edit: Edit): string {
  const result = applyEdit(text, edit, config, TODAY);
  expect(result).toEqual({ text: expect.any(String) });
  if (!("text" in result)) throw new Error("expected edited text");
  expectValid(result.text);
  return result.text;
}

function expectValid(text: string, filePath = "initiatives/acme/001-alpha/initiative.md"): void {
  const parsed = parseInitiativeFile(filePath, text, config);
  expect(parsed.kind).toBe("initiative");
  if (parsed.kind !== "initiative") return;
  const errors = validate([parsed], config).filter((issue) => issue.severity === "error");
  expect(errors).toEqual([]);
}

function expectStale(text: string, edit: Edit): void {
  expect(applyEdit(text, edit, config, TODAY)).toEqual({ error: "stale" });
}

describe("applyEdit", () => {
  const source = initiative(BASE);

  it("sets status, keeps comments, key order, and prose", () => {
    const text = applied(source, { kind: "setStatus", id: "acme-001", from: "idea", to: "review" });
    expect(text).toContain("# file note");
    expect(text).toContain("id: acme-001 # id note");
    expect(text).toContain("status: review # status note");
    expect(text).toContain("updated: 2026-10-01 # touched");
    expect(text).toContain("vikunja:");
    expect(text.indexOf("id:")).toBeLessThan(text.indexOf("title:"));
    expect(text.indexOf("title:")).toBeLessThan(text.indexOf("status:"));
    expect(text.indexOf("status:")).toBeLessThan(text.indexOf("priority:"));
    expect(text.indexOf("priority:")).toBeLessThan(text.indexOf("updated:"));
    expect(text.indexOf("updated:")).toBeLessThan(text.indexOf("vikunja:"));
    expect(bodyOf(text)).toBe(PROSE);
    expect(summarizeEdit({ kind: "setStatus", id: "acme-001", from: "idea", to: "review" })).toBe(
      "acme-001: status idea -> review",
    );
  });

  it("sets priority", () => {
    const text = applied(source, { kind: "setPriority", id: "acme-001", from: "p2", to: "p0" });
    expect(text).toContain("priority: p0");
    expect(bodyOf(text)).toBe(PROSE);
    expect(summarizeEdit({ kind: "setPriority", id: "acme-001", from: "p2", to: "p0" })).toBe(
      "acme-001: priority p2 -> p0",
    );
  });

  it("sets a phase status", () => {
    const text = applied(source, {
      kind: "setPhaseStatus",
      id: "acme-001",
      phase: 2,
      from: "idea",
      to: "done",
    });
    expect(text).toContain("status: done");
    expect(text).toContain("status: planned # phase note");
    expect(bodyOf(text)).toBe(PROSE);
    expect(
      summarizeEdit({ kind: "setPhaseStatus", id: "acme-001", phase: 2, from: "idea", to: "done" }),
    ).toBe("acme-001: phase 2 status idea -> done");
  });

  it("sets a title without rewriting the prose heading", () => {
    const text = applied(source, { kind: "setTitle", id: "acme-001", from: "Alpha", to: "Better: name" });
    const parsed = parseInitiativeFile("initiatives/acme/001-alpha/initiative.md", text, config);
    expect(parsed.kind).toBe("initiative");
    if (parsed.kind === "initiative") expect(parsed.frontmatter.title).toBe("Better: name");
    expect(bodyOf(text)).toBe(PROSE);
    expect(summarizeEdit({ kind: "setTitle", id: "acme-001", from: "Alpha", to: "Better: name" })).toBe(
      "acme-001: title Alpha -> Better: name",
    );
  });

  it("sets labels and treats a missing list as empty", () => {
    const text = applied(source, {
      kind: "setLabels",
      id: "acme-001",
      from: ["alpha", "beta"],
      to: ["site"],
    });
    expect(text).toContain("# labels note");
    const parsed = parseInitiativeFile("initiatives/acme/001-alpha/initiative.md", text, config);
    expect(parsed.kind).toBe("initiative");
    if (parsed.kind === "initiative") expect(parsed.frontmatter.labels).toEqual(["site"]);
    expect(bodyOf(text)).toBe(PROSE);

    const bare = initiative(BASE.replace("labels: # labels note\n  - alpha\n  - beta\n", ""));
    const added = applied(bare, { kind: "setLabels", id: "acme-001", from: [], to: ["site"] });
    const addedParsed = parseInitiativeFile("initiatives/acme/001-alpha/initiative.md", added, config);
    if (addedParsed.kind === "initiative") expect(addedParsed.frontmatter.labels).toEqual(["site"]);
    expect(summarizeEdit({ kind: "setLabels", id: "acme-001", from: [], to: ["site"] })).toBe(
      "acme-001: labels (none) -> site",
    );
  });

  it("rejects a stale from value", () => {
    expectStale(source, { kind: "setStatus", id: "acme-001", from: "done", to: "review" });
    expectStale(source, { kind: "setPriority", id: "acme-001", from: "p0", to: "p1" });
    expectStale(source, { kind: "setTitle", id: "acme-001", from: "Other", to: "Alpha" });
    expectStale(source, { kind: "setLabels", id: "acme-001", from: ["beta", "alpha"], to: ["site"] });
    expectStale(source, { kind: "setPhaseStatus", id: "acme-001", phase: 1, from: "done", to: "review" });
  });

  it("rejects an unknown phase and a status outside config", () => {
    expect(
      applyEdit(source, { kind: "setPhaseStatus", id: "acme-001", phase: 9, from: "idea", to: "done" }, config, TODAY),
    ).toEqual({ error: "unknown phase" });
    expect(
      applyEdit(source, { kind: "setStatus", id: "acme-001", from: "idea", to: "shipping" }, config, TODAY),
    ).toEqual({ error: "status not in config" });
    expect(
      applyEdit(
        source,
        { kind: "setPhaseStatus", id: "acme-001", phase: 1, from: "planned", to: "shipping" },
        config,
        TODAY,
      ),
    ).toEqual({ error: "status not in config" });
    expect(
      applyEdit(source, { kind: "setPriority", id: "acme-001", from: "p2", to: "p9" }, config, TODAY),
    ).toEqual({ error: "priority not in config" });
  });

  it("keeps CRLF files and their prose", () => {
    const original = initiative(BASE, PROSE, "\r\n");
    const text = applied(original, { kind: "setStatus", id: "acme-001", from: "idea", to: "planned" });
    expect(text).toContain("\r\n");
    expect(text).not.toMatch(/[^\r]\n/);
    expect(bodyOf(text)).toBe(PROSE.replaceAll("\n", "\r\n"));
    expect(text).toContain("status: planned # status note");
  });

  it("replaces the body, rejects a stale hash, preserves CRLF, and allows an empty body", () => {
    const text = applied(source, { kind: "setBody", id: "acme-001", fromHash: bodyHash(source), to: "Fresh\ntext\n" });
    expect(bodyOf(text)).toBe("Fresh\ntext\n");
    expect(frontOf(text).replaceAll(TODAY, "2026-09-01")).toBe(frontOf(source));
    expect(text).toContain("# file note");
    expect(text).toContain("status: idea # status note");
    expect(summarizeEdit({ kind: "setBody", id: "acme-001", fromHash: bodyHash(source), to: "Fresh\ntext\n" })).toBe(
      "acme-001: body",
    );

    expect(
      applyEdit(source, { kind: "setBody", id: "acme-001", fromHash: "a".repeat(64), to: "nope" }, config, TODAY),
    ).toEqual({ error: "stale" });

    const crlf = initiative(BASE, PROSE, "\r\n");
    const replaced = applied(crlf, { kind: "setBody", id: "acme-001", fromHash: bodyHash(crlf), to: "New\nbody\n" });
    expect(replaced).not.toMatch(/[^\r]\n/);
    expect(frontOf(replaced).replaceAll(TODAY, "2026-09-01")).toBe(frontOf(crlf));
    expect(bodyOf(replaced)).toBe("New\r\nbody\r\n");

    const emptied = applied(source, { kind: "setBody", id: "acme-001", fromHash: bodyHash(source), to: "" });
    expect(bodyOf(emptied)).toBe("");
    expect(bodyHash(emptied)).toBe(createHash("sha256").update("", "utf8").digest("hex"));
    expectValid(emptied);
  });

  it("keeps the frontmatter when edit values look like YAML or a fence", () => {
    const text = initiative(BASE);
    const injectedBody = ["---", "id: other-009", "status: done", "---", "", "# Taken over", ""].join(NL);
    const body = applyEdit(text, { kind: "setBody", id: "acme-001", fromHash: bodyHash(text), to: injectedBody }, config, TODAY);
    if ("error" in body) throw new Error(body.error);
    const parsedBody = parseInitiativeFile("initiatives/acme/001-alpha/initiative.md", body.text, config);
    expect(parsedBody.kind).toBe("initiative");
    if (parsedBody.kind !== "initiative") return;
    expect(parsedBody.frontmatter.id).toBe("acme-001");
    expect(parsedBody.frontmatter.status).toBe("idea");

    const title = applyEdit(
      text,
      { kind: "setTitle", id: "acme-001", from: "Alpha", to: "x\" status: done # ---" },
      config,
      TODAY,
    );
    if ("error" in title) throw new Error(title.error);
    const parsedTitle = parseInitiativeFile("initiatives/acme/001-alpha/initiative.md", title.text, config);
    if (parsedTitle.kind !== "initiative") throw new Error("not an initiative");
    expect(parsedTitle.frontmatter.title).toBe("x\" status: done # ---");
    expect(parsedTitle.frontmatter.status).toBe("idea");

    const labels = applyEdit(
      text,
      { kind: "setLabels", id: "acme-001", from: ["alpha", "beta"], to: ["a: b", "- c", "{d}"] },
      config,
      TODAY,
    );
    if ("error" in labels) throw new Error(labels.error);
    const parsedLabels = parseInitiativeFile("initiatives/acme/001-alpha/initiative.md", labels.text, config);
    if (parsedLabels.kind !== "initiative") throw new Error("not an initiative");
    expect(parsedLabels.frontmatter.labels).toEqual(["a: b", "- c", "{d}"]);
  });

  it("hashes the body the reader saw", () => {
    expect(bodyHash(source)).toBe(createHash("sha256").update(PROSE, "utf8").digest("hex"));
    const crlf = initiative(BASE, PROSE, "\r\n");
    expect(bodyHash(crlf)).toBe(createHash("sha256").update(PROSE.replaceAll("\n", "\r\n"), "utf8").digest("hex"));
  });

  it("does not read or write files", () => {
    const implementation = readFileSync(new URL("./edits.ts", import.meta.url), "utf8");
    expect(implementation).not.toMatch(/node:fs|node:http|node:child_process|readFile|writeFile/);
  });
});

describe("renderNewInitiative", () => {
  it("fills the built-in template and passes the validator", () => {
    const template = readFileSync(new URL("./templates/initiative.md", import.meta.url), "utf8");
    const title = 'Say "hi": now';
    const rendered = renderNewInitiative(
      { project: "acme", slug: "widgets", title, status: "planned", priority: "p1" },
      4,
      config,
      TODAY,
    );
    const expected = template.replaceAll(/\{\{([A-Za-z]+)\}\}/g, (match, key: string) => {
      const values: Record<string, string> = {
        id: "acme-004",
        title,
        titleYaml: '"Say \\"hi\\": now"',
        status: "planned",
        priority: "p1",
        updated: TODAY,
      };
      return values[key] ?? match;
    });
    expect(rendered.path).toBe("initiatives/acme/004-widgets/initiative.md");
    expect(rendered.text).toBe(expected);
    expectValid(rendered.text, rendered.path);
    expect(
      summarizeEdit({
        kind: "createInitiative",
        project: "acme",
        slug: "widgets",
        title,
        status: "planned",
        priority: "p1",
      }),
    ).toBe('create acme/widgets: Say "hi": now');
  });

  it("writes a given body verbatim after the generated frontmatter", () => {
    const body = ["# Widgets", "", "Custom *text*  ", "", "- [ ] item"].join(NL);
    const rendered = renderNewInitiative(
      { project: "acme", slug: "widgets", title: "Widgets", status: "planned", priority: "p1", body },
      4,
      config,
      TODAY,
    );
    const head = ["---", "id: acme-004", 'title: "Widgets"', "status: planned", "priority: p1", `updated: ${TODAY}`, "---", ""];
    expect(rendered.text).toBe([...head, body, ""].join(NL));
    expectValid(rendered.text, rendered.path);
    expect(bodyHash(rendered.text)).toBe(createHash("sha256").update(["", body, ""].join(NL), "utf8").digest("hex"));
  });

  it("cannot inject frontmatter through the body", () => {
    const body = ["---", "id: evil-001", "status: done", "---", "# Evil"].join(NL);
    const rendered = renderNewInitiative(
      { project: "acme", slug: "widgets", title: "Widgets", status: "planned", priority: "p1", body },
      4,
      config,
      TODAY,
    );
    const parsed = parseInitiativeFile(rendered.path, rendered.text, config);
    expect(parsed.kind).toBe("initiative");
    if (parsed.kind !== "initiative") return;
    expect(parsed.frontmatter.id).toBe("acme-004");
    expect(parsed.frontmatter.status).toBe("planned");
    expect(rendered.text.startsWith(["---", "id: acme-004", ""].join(NL))).toBe(true);
  });

  it("limits the body size in the schema and the renderer", () => {
    const create = {
      kind: "createInitiative",
      project: "acme",
      slug: "widgets",
      title: "Widgets",
      status: "planned",
      priority: "p1",
    } as const;
    expect(EditSchema.safeParse({ ...create, body: "x".repeat(MAX_INITIATIVE_BODY_LENGTH) }).success).toBe(true);
    expect(EditSchema.safeParse({ ...create, body: "x".repeat(MAX_INITIATIVE_BODY_LENGTH + 1) }).success).toBe(false);
    expect(
      EditSchema.safeParse({ kind: "setBody", id: "acme-001", fromHash: "a".repeat(64), to: "x".repeat(MAX_INITIATIVE_BODY_LENGTH + 1) })
        .success,
    ).toBe(false);
    expect(() =>
      renderNewInitiative({ ...create, body: "x".repeat(MAX_INITIATIVE_BODY_LENGTH + 1) }, 4, config, TODAY),
    ).toThrow("Body is too long.");
  });

  it("adds depends_on inside the frontmatter", () => {
    const rendered = renderNewInitiative(
      {
        project: "acme",
        slug: "widgets",
        title: "Widgets",
        status: "planned",
        priority: "p2",
        depends_on: ["acme-001", "acme-001#2"],
      },
      5,
      config,
      TODAY,
    );
    expect(rendered.text).toContain("depends_on:\n  - acme-001\n  - acme-001#2\n---");
    expect(rendered.text).toContain("## Summary");
    const parsed = parseInitiativeFile(rendered.path, rendered.text, config);
    expect(parsed.kind).toBe("initiative");
    if (parsed.kind === "initiative") {
      expect(parsed.frontmatter.depends_on).toEqual(["acme-001", "acme-001#2"]);
      const errors = validate([parsed], config, { knownIds: new Set(["acme-001", "acme-001#2"]) }).filter(
        (issue) => issue.severity === "error",
      );
      expect(errors).toEqual([]);
    }
  });

  it("rejects a status outside config", () => {
    expect(() =>
      renderNewInitiative(
        { project: "acme", slug: "widgets", title: "Widgets", status: "shipping", priority: "p2" },
        1,
        config,
        TODAY,
      ),
    ).toThrow(/Status "shipping"/);
  });
});

describe("EditSchema", () => {
  it("rejects an unknown kind and createInitiative applied to a file", () => {
    expect(EditSchema.safeParse({ kind: "rename" }).success).toBe(false);
    const result = applyEdit(initiative(BASE), { kind: "createInitiative" } as unknown as Edit, config, TODAY);
    expect(result).toEqual({ error: "invalid edit" });
  });
});
describe("setIcon", () => {
  const file = (yaml: string) => `---\n${yaml}---\n\n# Alpha\n`;
  const base = "id: acme-001\ntitle: Alpha\nstatus: idea\npriority: p2\nupdated: 2026-09-01\n";

  it("adds, replaces and removes the icon", () => {
    const added = applyEdit(file(base), { kind: "setIcon", id: "acme-001", from: "", to: "🚀" }, config, TODAY);
    expect(added).toEqual({ text: file(base.replace("2026-09-01", TODAY) + "icon: 🚀\n") });
    if (!("text" in added)) throw new Error("expected text");
    const replaced = applyEdit(added.text, { kind: "setIcon", id: "acme-001", from: "🚀", to: "assets/icon.png" }, config, TODAY);
    expect("text" in replaced && replaced.text.includes("icon: assets/icon.png")).toBe(true);
    if (!("text" in replaced)) throw new Error("expected text");
    const removed = applyEdit(replaced.text, { kind: "setIcon", id: "acme-001", from: "assets/icon.png", to: "" }, config, TODAY);
    expect("text" in removed && removed.text.includes("icon")).toBe(false);
  });

  it("refuses a stale from and an invalid icon", () => {
    expect(applyEdit(file(base), { kind: "setIcon", id: "acme-001", from: "🧩", to: "🚀" }, config, TODAY)).toEqual({
      error: "stale",
    });
    expect(applyEdit(file(base), { kind: "setIcon", id: "acme-001", from: "", to: "../x.png" }, config, TODAY)).toEqual({
      error: "invalid edit",
    });
    expect(EditSchema.safeParse({ kind: "setIcon", id: "acme-001", from: "", to: "text" }).success).toBe(false);
  });

  it("summarizes the change", () => {
    expect(summarizeEdit({ kind: "setIcon", id: "acme-001", from: "", to: "🚀" })).toBe("acme-001: icon (none) -> 🚀");
  });
});
