import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadConfig, type Config } from "./config.js";
import { main, type CliIo } from "./cli.js";
import { fixInitiativeText } from "./fix.js";

const config = loadConfig();
const parents: string[] = [];

afterEach(async () => {
  const pending = parents.splice(0);
  await Promise.all(pending.map((dir) => rm(dir, { recursive: true, force: true })));
});

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

function document(yaml: string, body: string): string {
  return `---\n${yaml.trim()}\n---\n${body}`;
}

function bodyOf(text: string): string {
  const matched = FRONTMATTER.exec(text.replace(/^\uFEFF/, ""));
  if (!matched) throw new Error("frontmatter was not found");
  return matched[2] ?? "";
}

function yamlOf(text: string): Record<string, unknown> {
  const matched = FRONTMATTER.exec(text.replace(/^\uFEFF/, ""));
  if (!matched?.[1]) throw new Error("frontmatter was not found");
  return parse(matched[1], { schema: "core" }) as Record<string, unknown>;
}

function fix(folder: string, yaml: string, body = "# Title\n\n## Summary\n\nBody.\n", cfg: Config = config) {
  const filePath = `initiatives/${folder}/initiative.md`;
  return fixInitiativeText(filePath, document(yaml, body), cfg);
}

describe("snoboard fix", () => {
  it("normalises status, priority, and phase status to config values", () => {
    const result = fix(
      "acme/001-onboarding",
      `
id: acme-001
title: Onboarding
status: In Progress
priority: P1
updated: 2026-09-03
phases:
  - id: 1
    title: First
    status: in_progress
`,
    );
    expect(result.changed).toBe(true);
    const data = yamlOf(result.text);
    expect(data.status).toBe("in-progress");
    expect(data.priority).toBe("p1");
    expect(data.phases).toEqual([{ id: 1, title: "First", status: "in-progress" }]);
    expect(result.events.map((event) => `${event.field}: ${"from" in event ? event.from : event.message}`)).toEqual([
      'status: "In Progress"',
      'priority: "P1"',
      'phases[0].status: "in_progress"',
    ]);

    const custom = loadConfig("statuses:\n  - idea\n  - doing\n  - done\n");
    const renamed = fix(
      "acme/001-onboarding",
      `
id: acme-001
title: Onboarding
status: Doing
priority: p2
updated: 2026-09-03
`,
      "# Title\n",
      custom,
    );
    expect(yamlOf(renamed.text).status).toBe("doing");
  });

  it("reports unknown status and priority without changing them", () => {
    const yaml = `
id: acme-001
title: Onboarding
status: underway
priority: urgent
updated: 2026-09-03
phases:
  - id: 1
    title: First
    status: blocked
`;
    const original = document(yaml, "# Title\n");
    const result = fix("acme/001-onboarding", yaml, "# Title\n");
    expect(result.changed).toBe(false);
    expect(result.text).toBe(original);
    expect(result.events).toEqual([
      {
        path: "initiatives/acme/001-onboarding/initiative.md",
        field: "status",
        message: 'unknown value "underway"',
      },
      {
        path: "initiatives/acme/001-onboarding/initiative.md",
        field: "priority",
        message: 'unknown value "urgent"',
      },
      {
        path: "initiatives/acme/001-onboarding/initiative.md",
        field: "phases[0].status",
        message: 'unknown value "blocked"',
      },
    ]);
  });

  it("fixes an id that mismatches only by case or padding", () => {
    const cased = fix(
      "acme/004-search",
      `
id: Acme-4
title: Search
status: planned
priority: p2
updated: 2026-09-03
`,
    );
    expect(yamlOf(cased.text).id).toBe("acme-004");
    expect(cased.events).toEqual([
      {
        path: "initiatives/acme/004-search/initiative.md",
        field: "id",
        from: '"Acme-4"',
        to: '"acme-004"',
      },
    ]);

    const padded = fix(
      "acme/004-search",
      `
id: acme-0004
title: Search
status: planned
priority: p2
updated: 2026-09-03
`,
    );
    expect(yamlOf(padded.text).id).toBe("acme-004");
  });

  it("leaves an id that names a different initiative", () => {
    const yaml = `
id: billing-004
title: Search
status: planned
priority: p2
updated: 2026-09-03
`;
    const result = fix("acme/004-search", yaml);
    expect(result.changed).toBe(false);
    expect(result.events).toEqual([]);
    expect(yamlOf(result.text).id).toBe("billing-004");
  });

  it("normalises updated dates to YYYY-MM-DD", () => {
    const result = fix(
      "acme/001-onboarding",
      `
id: acme-001
title: Onboarding
status: planned
priority: p2
updated: 2026-9-3
`,
    );
    expect(yamlOf(result.text).updated).toBe("2026-09-03");
    expect(result.events[0]).toMatchObject({ field: "updated", from: '"2026-9-3"', to: '"2026-09-03"' });

    const slashed = fix(
      "acme/001-onboarding",
      `
id: acme-001
title: Onboarding
status: planned
priority: p2
updated: 2026/9/03
`,
    );
    expect(yamlOf(slashed.text).updated).toBe("2026-09-03");

    const invalid = `
id: acme-001
title: Onboarding
status: planned
priority: p2
updated: 2026-13-01
`;
    const reported = fix("acme/001-onboarding", invalid);
    expect(reported.changed).toBe(false);
    expect(reported.text).toBe(document(invalid, "# Title\n\n## Summary\n\nBody.\n"));
    expect(reported.events).toEqual([
      {
        path: "initiatives/acme/001-onboarding/initiative.md",
        field: "updated",
        message: 'unknown value "2026-13-01"',
      },
    ]);
  });

  it("turns depends_on into a list, drops duplicates, and drops self-references", () => {
    const scalar = fix(
      "acme/002-billing",
      `
id: acme-002
title: Billing
status: planned
priority: p2
updated: 2026-09-03
depends_on: acme-001
`,
    );
    expect(yamlOf(scalar.text).depends_on).toEqual(["acme-001"]);
    expect(scalar.events[0]).toMatchObject({
      field: "depends_on",
      from: '"acme-001"',
      to: '["acme-001"]',
    });

    const cleaned = fix(
      "acme/002-billing",
      `
id: acme-002
title: Billing
status: planned
priority: p2
updated: 2026-09-03
depends_on:
  - acme-001
  - acme-001
  - acme-002
  - acme-002#1
  - Acme-2
  - acme-003
`,
    );
    expect(yamlOf(cleaned.text).depends_on).toEqual(["acme-001", "acme-003"]);
  });

  it("renumbers phase ids only when they are missing and drops identical phases", () => {
    const result = fix(
      "acme/003-reports",
      `
id: acme-003
title: Reports
status: planned
priority: p2
updated: 2026-09-03
phases:
  - title: Collect
    status: planned
  - id: 5
    title: Publish
    status: planned
  - id: 5
    title: Publish
    status: planned
  - id: 1
    title: Other
    status: planned
  - id: 1
    title: Kept
    status: planned
`,
    );
    expect(yamlOf(result.text).phases).toEqual([
      { id: 6, title: "Collect", status: "planned" },
      { id: 5, title: "Publish", status: "planned" },
      { id: 1, title: "Other", status: "planned" },
      { id: 1, title: "Kept", status: "planned" },
    ]);
    expect(result.events).toEqual([
      {
        path: "initiatives/acme/003-reports/initiative.md",
        field: "phases[2]",
        from: '{"id":5,"title":"Publish","status":"planned"}',
        to: "(removed duplicate)",
      },
      {
        path: "initiatives/acme/003-reports/initiative.md",
        field: "phases[0].id",
        from: "(missing)",
        to: "6",
      },
    ]);
  });

  it("leaves the markdown body byte-for-byte and keeps unrelated YAML", () => {
    const body = "# Search\n\n## Summary\n\n  trailing spaces  \n\n---\nstill the body\n\u2603\n";
    const yaml = `
# keep
id: acme-004 # id comment
title: "This title is deliberately long enough that a default eighty column wrap would fold it onto a second line" # title
status: In Progress
priority: p2
updated: 2026-09-03
custom: true
`;
    const result = fix("acme/004-search", yaml, body);
    expect(result.changed).toBe(true);
    expect(bodyOf(result.text)).toBe(body);
    expect(result.text).toContain("# keep");
    expect(result.text).toContain("# id comment");
    expect(result.text).toContain("# title");
    expect(result.text).toContain(
      'title: "This title is deliberately long enough that a default eighty column wrap would fold it onto a second line"',
    );
    expect(yamlOf(result.text).custom).toBe(true);
    const keys = [...result.text.matchAll(/^([A-Za-z0-9_]+):/gm)].map((match) => match[1]);
    expect(keys).toEqual(["id", "title", "status", "priority", "updated", "custom"]);
  });

  it("does not touch legacy files", () => {
    const frontmatter = document(
      `
title: Old
status: In Progress
priority: P1
updated: 2026-9-3
`,
      "# Old\n\n## Summary\n\nLeave this byte-for-byte.\n",
    );
    const parsed = fixInitiativeText("initiatives/acme/009-old/initiative.md", frontmatter, config);
    expect(parsed).toEqual({ text: frontmatter, changed: false, events: [] });

    const plain = "# Initiative: Old\n\nstatus: In Progress\n";
    const bare = fixInitiativeText("initiatives/acme/009-old/initiative.md", plain, config);
    expect(bare).toEqual({ text: plain, changed: false, events: [] });
  });

  it("exits 1 on --dry-run when changes are pending and writes them otherwise", async () => {
    const dir = await tempRepo();
    const relative = path.join("initiatives", "acme", "001-onboarding", "initiative.md");
    const absolute = path.join(dir, relative);
    const body = "# Onboarding\n\n## Summary\n\nKeep.\n";
    const original = document(
      `
id: acme-001
title: Onboarding
status: In Progress
priority: p2
updated: 2026-09-03
`,
      body,
    );
    await writeFile(absolute, original);

    const gitCalls: string[][] = [];
    const pending = await run(["fix", "--repo", dir, "--dry-run"], gitCalls);
    expect(pending.code).toBe(1);
    expect(pending.stdout).toContain('status: "In Progress" -> "in-progress"');
    expect(pending.stderr).toBe("");
    expect(await readFile(absolute, "utf8")).toBe(original);
    expect(gitCalls).toEqual([]);

    const applied = await run(["fix", "--repo", dir]);
    expect(applied.code).toBe(0);
    const written = await readFile(absolute, "utf8");
    expect(written).not.toBe(original);
    expect(bodyOf(written)).toBe(body);
    expect(yamlOf(written).status).toBe("in-progress");

    const again = await run(["fix", "--repo", dir, "--dry-run"]);
    expect(again.code).toBe(0);
    expect(again.stdout).toBe("");
  });

  it("limits work to the given paths and can print JSON", async () => {
    const dir = await tempRepo();
    await writeInitiative(dir, "acme", "001-onboarding", "status: In Progress");
    await writeInitiative(dir, "acme", "002-billing", "status: Planned");

    const one = await run([
      "fix",
      "--repo",
      dir,
      "initiatives/acme/002-billing/initiative.md",
    ]);
    expect(one.code).toBe(0);
    expect(one.stdout).toContain("002-billing");
    expect(one.stdout).not.toContain("001-onboarding");
    expect(yamlOf(await readFile(path.join(dir, "initiatives", "acme", "001-onboarding", "initiative.md"), "utf8")).status).toBe(
      "In Progress",
    );
    expect(yamlOf(await readFile(path.join(dir, "initiatives", "acme", "002-billing", "initiative.md"), "utf8")).status).toBe(
      "planned",
    );

    const json = await run(["fix", "--repo", dir, "--json", "--dry-run"]);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout)).toEqual([
      {
        path: "initiatives/acme/001-onboarding/initiative.md",
        field: "status",
        from: '"In Progress"',
        to: '"in-progress"',
      },
    ]);
    expect((await run(["fix", "--fetch"])).code).toBe(2);
    expect((await run(["validate", "--dry-run"])).code).toBe(2);
  });
});

async function tempRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "snoboard-fix-"));
  parents.push(dir);
  await mkdir(path.join(dir, "initiatives", "acme", "001-onboarding"), { recursive: true });
  return dir;
}

async function writeInitiative(dir: string, project: string, folder: string, statusLine: string): Promise<void> {
  const folderPath = path.join(dir, "initiatives", project, folder);
  await mkdir(folderPath, { recursive: true });
  const number = folder.slice(0, 3);
  await writeFile(
    path.join(folderPath, "initiative.md"),
    document(
      `
id: ${project}-${number}
title: Item
${statusLine}
priority: p2
updated: 2026-09-03
`,
      "# Item\n",
    ),
  );
}

async function run(
  args: readonly string[],
  gitCalls?: string[][],
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const io: Partial<CliIo> = {
    cwd: process.cwd(),
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    onGit: gitCalls === undefined ? undefined : (argv) => gitCalls.push([...argv]),
  };
  const code = await main(args, io);
  return { code, stdout, stderr };
}
