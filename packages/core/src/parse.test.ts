import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { parseInitiativeFile } from "./parse.js";

const demoRoot = fileURLToPath(new URL("../../../examples/demo-repo/", import.meta.url));
const config = loadConfig(readFileSync(join(demoRoot, ".snoboard.yml"), "utf8"));

function parseDemo(relativePath: string) {
  const text = readFileSync(join(demoRoot, ...relativePath.split("/")), "utf8");
  return parseInitiativeFile(relativePath, text, config);
}

describe("parseInitiativeFile", () => {
  it("parses each demo file to the expected kind", () => {
    const relativePaths: string[] = [];
    const initiatives = join(demoRoot, "initiatives");
    for (const project of readdirSync(initiatives)) {
      const projectDir = join(initiatives, project);
      if (!statSync(projectDir).isDirectory()) continue;
      for (const folder of readdirSync(projectDir)) {
        const folderDir = join(projectDir, folder);
        if (!statSync(folderDir).isDirectory()) continue;
        relativePaths.push(`initiatives/${project}/${folder}/initiative.md`);
      }
    }
    relativePaths.sort();

    expect(relativePaths).toEqual([
      "initiatives/acme/001-onboarding/initiative.md",
      "initiatives/acme/002-billing/initiative.md",
      "initiatives/acme/003-reports/initiative.md",
      "initiatives/platform/001-ci/initiative.md",
      "initiatives/platform/002-broken/initiative.md",
    ]);

    const onboarding = parseDemo("initiatives/acme/001-onboarding/initiative.md");
    expect(onboarding).toMatchObject({
      kind: "initiative",
      project: "acme",
      number: "001",
      summary: "Guide a new customer from signup to a first project.",
      frontmatter: {
        id: "acme-001",
        status: "done",
        phases: [
          { id: 1, status: "done" },
          { id: 2, status: "done", depends_on: [1] },
        ],
      },
    });

    const billing = parseDemo("initiatives/acme/002-billing/initiative.md");
    expect(billing).toMatchObject({
      kind: "initiative",
      project: "acme",
      number: "002",
      summary: "Charge customers for the plans they select.",
      frontmatter: { id: "acme-002", status: "in-progress", depends_on: ["acme-001"] },
    });

    const reports = parseDemo("initiatives/acme/003-reports/initiative.md");
    expect(reports).toMatchObject({
      kind: "initiative",
      project: "acme",
      number: "003",
      summary: "Show usage and invoices together.",
      frontmatter: { id: "acme-003", status: "planned", depends_on: ["acme-002"] },
    });

    const legacy = parseDemo("initiatives/platform/001-ci/initiative.md");
    expect(legacy).toMatchObject({
      kind: "legacy",
      project: "platform",
      number: "001",
      title: "Continuous integration",
      summary: "Run checks on every change.",
    });

    const brokenPath = "initiatives/platform/002-broken/initiative.md";
    expect(() => parseDemo(brokenPath)).not.toThrow();
    const broken = parseDemo(brokenPath);
    expect(broken.kind).toBe("error");
    if (broken.kind === "error") expect(broken.message.length).toBeGreaterThan(0);
  });

  it("extracts project and number, including _shared", () => {
    const text = [
      "---",
      "id: _shared-011",
      "title: Design tokens",
      "status: idea",
      "priority: p3",
      "updated: 2026-09-29",
      "---",
      "",
      "## Summary",
      "",
      "Shared tokens.",
      "",
    ].join("\n");
    const parsed = parseInitiativeFile("initiatives\\_shared\\011-tokens\\initiative.md", text, config);
    expect(parsed).toMatchObject({
      kind: "initiative",
      project: "_shared",
      number: "011",
    });
  });

  it("extracts a summary from CRLF text and allows a missing Summary section", () => {
    const withSummary = [
      "---",
      "id: acme-004",
      "title: Search",
      "status: planned",
      "priority: p2",
      "updated: 2026-09-29",
      "---",
      "",
      "## Summary",
      "",
      "Line one.",
      "Line two.",
      "",
      "## Goals",
      "",
      "Later.",
      "",
    ].join("\r\n");
    const parsed = parseInitiativeFile("initiatives/acme/004-search/initiative.md", withSummary, config);
    expect(parsed).toMatchObject({
      kind: "initiative",
      summary: "Line one.\nLine two.",
    });

    const missing = [
      "---",
      "id: acme-004",
      "title: Search",
      "status: planned",
      "priority: p2",
      "updated: 2026-09-29",
      "---",
      "",
      "# Search",
      "",
      "## Goals",
      "",
      "No summary here.",
      "",
    ].join("\n");
    expect(parseInitiativeFile("initiatives/acme/004-search/initiative.md", missing, config)).toMatchObject({
      kind: "initiative",
      summary: "",
    });
  });

  it("treats frontmatter without an id as legacy", () => {
    const text = ["---", "title: Old notes", "---", "", "# Initiative: Old notes", "", "## Summary", "", "Kept as legacy.", ""].join("\n");
    expect(parseInitiativeFile("initiatives/platform/003-notes/initiative.md", text, config)).toMatchObject({
      kind: "legacy",
      project: "platform",
      number: "003",
      title: "Old notes",
      summary: "Kept as legacy.",
    });
  });

  it("returns an error for schema-invalid frontmatter without throwing", () => {
    const text = ["---", "id: acme-004", "title: Search", "status: nope", "priority: p2", "updated: 2026-09-29", "---", ""].join("\n");
    const path = "initiatives/acme/004-search/initiative.md";
    expect(() => parseInitiativeFile(path, text, config)).not.toThrow();
    const parsed = parseInitiativeFile(path, text, config);
    expect(parsed.kind).toBe("error");
  });
});
describe("parseInitiativeFile review additions", () => {
  it("supports a nested root folder", async () => {
    const { loadConfig } = await import("./config.js");
    const config = loadConfig("root: docs/initiatives\n");
    const parsed = parseInitiativeFile(
      "docs/initiatives/acme/001-x/initiative.md",
      "# Initiative: X\n",
      config,
    );
    expect(parsed.kind).toBe("legacy");
  });

  it("treats unparseable YAML without an id as legacy", async () => {
    const { loadConfig } = await import("./config.js");
    const parsed = parseInitiativeFile(
      "initiatives/acme/001-x/initiative.md",
      "---\nvikunja: [unclosed\n---\n# X\n",
      loadConfig(),
    );
    expect(parsed.kind).toBe("legacy");
  });

  it("rejects a phase reference with leading zeros", () => {
    const rejected = [
      "---",
      "id: acme-002",
      "title: Billing",
      "status: planned",
      "priority: p2",
      "depends_on: [acme-001#001]",
      "updated: 2026-09-29",
      "---",
      "",
    ].join("\n");
    const parsed = parseInitiativeFile("initiatives/acme/002-billing/initiative.md", rejected, loadConfig());
    expect(parsed.kind).toBe("error");

    const accepted = [
      "---",
      "id: acme-002",
      "title: Billing",
      "status: planned",
      "priority: p2",
      "depends_on: [acme-001#1]",
      "updated: 2026-09-29",
      "---",
      "",
    ].join("\n");
    expect(parseInitiativeFile("initiatives/acme/002-billing/initiative.md", accepted, loadConfig())).toMatchObject({
      kind: "initiative",
      frontmatter: { depends_on: ["acme-001#1"] },
    });
  });
});
