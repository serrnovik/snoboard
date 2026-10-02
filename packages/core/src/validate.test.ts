import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import { parseInitiativeFile, type ParsedFile } from "./parse.js";
import type { Phase } from "./schema.js";
import { validate } from "./validate.js";

const config = loadConfig();
const demoRoot = fileURLToPath(new URL("../../../examples/demo-repo/", import.meta.url));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-29T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

function initiative(partial: {
  path: string;
  project: string;
  number: string;
  id: string;
  status?: string;
  depends_on?: string[];
  updated?: string;
  phases?: Phase[];
}): ParsedFile {
  return {
    kind: "initiative",
    path: partial.path,
    project: partial.project,
    number: partial.number,
    summary: "",
    frontmatter: {
      id: partial.id,
      title: "Title",
      status: partial.status ?? "planned",
      priority: "p2",
      depends_on: partial.depends_on ?? [],
      updated: partial.updated ?? "2026-09-29",
      ...(partial.phases ? { phases: partial.phases } : {}),
    },
  };
}

function phase(id: number, status: string, depends_on?: number[]): Phase {
  return {
    id,
    title: `Phase ${id}`,
    status,
    ...(depends_on ? { depends_on } : {}),
  };
}

describe("validate", () => {
  it("reports an id that does not match the path", () => {
    const issues = validate(
      [
        initiative({
          path: "initiatives/acme/001-onboarding/initiative.md",
          project: "acme",
          number: "001",
          id: "acme-002",
        }),
      ],
      config,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ field: "id", severity: "error" });
  });

  it("reports a duplicate id", () => {
    const issues = validate(
      [
        initiative({
          path: "initiatives/acme/001-onboarding/initiative.md",
          project: "acme",
          number: "001",
          id: "acme-001",
        }),
        initiative({
          path: "initiatives/acme/001-retry/initiative.md",
          project: "acme",
          number: "001",
          id: "acme-001",
        }),
      ],
      config,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      field: "id",
      severity: "error",
      path: "initiatives/acme/001-retry/initiative.md",
    });
  });

  it("reports a depends_on target that is not in the files or known ids", () => {
    const file = initiative({
      path: "initiatives/acme/002-billing/initiative.md",
      project: "acme",
      number: "002",
      id: "acme-002",
      depends_on: ["acme-999"],
    });
    const issues = validate([file], config);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ field: "depends_on", severity: "error" });
    expect(validate([file], config, { knownIds: new Set(["acme-999"]) })).toEqual([]);

    const phaseTarget = initiative({
      path: "initiatives/acme/002-billing/initiative.md",
      project: "acme",
      number: "002",
      id: "acme-002",
      depends_on: ["acme-001#9"],
    });
    const owner = initiative({
      path: "initiatives/acme/001-onboarding/initiative.md",
      project: "acme",
      number: "001",
      id: "acme-001",
      status: "done",
      phases: [phase(1, "done"), phase(2, "done")],
    });
    const missingPhase = validate([owner, phaseTarget], config);
    expect(missingPhase).toHaveLength(1);
    expect(missingPhase[0]).toMatchObject({ field: "depends_on", severity: "error" });
    expect(validate([owner, phaseTarget], config, { knownIds: new Set(["acme-001#9"]) })).toEqual([]);
  });

  it("reports a dependency cycle", () => {
    const issues = validate(
      [
        initiative({
          path: "initiatives/acme/001-alpha/initiative.md",
          project: "acme",
          number: "001",
          id: "acme-001",
          depends_on: ["acme-002"],
        }),
        initiative({
          path: "initiatives/acme/002-beta/initiative.md",
          project: "acme",
          number: "002",
          id: "acme-002",
          depends_on: ["acme-001"],
        }),
      ],
      config,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ field: "depends_on", severity: "error" });
    expect(issues[0]?.message).toMatch(/cycle/);
  });

  it("reports a done initiative with an in-progress or review phase", () => {
    const issues = validate(
      [
        initiative({
          path: "initiatives/acme/001-onboarding/initiative.md",
          project: "acme",
          number: "001",
          id: "acme-001",
          status: "done",
          phases: [phase(1, "done"), phase(2, "in-progress")],
        }),
      ],
      config,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ field: "phases", severity: "error" });

    const review = validate(
      [
        initiative({
          path: "initiatives/acme/001-onboarding/initiative.md",
          project: "acme",
          number: "001",
          id: "acme-001",
          status: "done",
          phases: [phase(1, "review")],
        }),
      ],
      config,
    );
    expect(review).toHaveLength(1);
    expect(review[0]).toMatchObject({ field: "phases", severity: "error" });

    const planned = validate(
      [
        initiative({
          path: "initiatives/acme/001-onboarding/initiative.md",
          project: "acme",
          number: "001",
          id: "acme-001",
          status: "done",
          phases: [phase(1, "planned")],
        }),
      ],
      config,
    );
    expect(planned).toEqual([]);
  });

  it("reports a phase depends_on that points at a missing phase", () => {
    const issues = validate(
      [
        initiative({
          path: "initiatives/acme/001-onboarding/initiative.md",
          project: "acme",
          number: "001",
          id: "acme-001",
          phases: [phase(1, "planned"), phase(2, "planned", [9])],
        }),
      ],
      config,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ field: "phases", severity: "error" });
  });

  it("reports a duplicate phase id", () => {
    const issues = validate(
      [
        initiative({
          path: "initiatives/acme/001-onboarding/initiative.md",
          project: "acme",
          number: "001",
          id: "acme-001",
          phases: [phase(1, "planned"), phase(1, "done")],
        }),
      ],
      config,
    );
    expect(issues).toEqual([
      {
        path: "initiatives/acme/001-onboarding/initiative.md",
        field: "phases",
        message: "duplicate phase id 1",
        severity: "error",
      },
    ]);
  });

  it("reports kind error files", () => {
    const issues = validate(
      [
        {
          kind: "error",
          path: "initiatives/platform/002-broken/initiative.md",
          message: "bad yaml",
        },
      ],
      config,
    );
    expect(issues).toEqual([
      {
        path: "initiatives/platform/002-broken/initiative.md",
        field: "frontmatter",
        message: "bad yaml",
        severity: "error",
      },
    ]);
  });

  it("ignores legacy files", () => {
    const issues = validate(
      [
        {
          kind: "legacy",
          path: "initiatives/platform/001-ci/initiative.md",
          project: "platform",
          number: "001",
          title: "Continuous integration",
          summary: "Run checks on every change.",
        },
      ],
      config,
    );
    expect(issues).toEqual([]);
  });

  it("warns when updated is older than staleAfterDays", () => {
    const stale = validate(
      [
        initiative({
          path: "initiatives/acme/002-billing/initiative.md",
          project: "acme",
          number: "002",
          id: "acme-002",
          status: "in-progress",
          updated: "2026-08-28",
        }),
      ],
      config,
    );
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ field: "updated", severity: "warning" });

    expect(
      validate(
        [
          initiative({
            path: "initiatives/acme/002-billing/initiative.md",
            project: "acme",
            number: "002",
            id: "acme-002",
            updated: "2026-08-30",
          }),
        ],
        config,
      ),
    ).toEqual([]);

    for (const status of ["done", "parked", "dropped"]) {
      expect(
        validate(
          [
            initiative({
              path: "initiatives/acme/002-billing/initiative.md",
              project: "acme",
              number: "002",
              id: "acme-002",
              status,
              updated: "2026-01-01",
            }),
          ],
          config,
        ),
      ).toEqual([]);
    }
  });

  it("reports only the broken file in the demo repo", () => {
    const demoConfig = loadConfig(readFileSync(join(demoRoot, ".snoboard.yml"), "utf8"));
    const files = [];
    const initiatives = join(demoRoot, "initiatives");
    for (const project of readdirSync(initiatives)) {
      const projectDir = join(initiatives, project);
      if (!statSync(projectDir).isDirectory()) continue;
      for (const folder of readdirSync(projectDir)) {
        const folderDir = join(projectDir, folder);
        if (!statSync(folderDir).isDirectory()) continue;
        const relativePath = `initiatives/${project}/${folder}/initiative.md`;
        files.push(parseInitiativeFile(relativePath, readFileSync(join(folderDir, "initiative.md"), "utf8"), demoConfig));
      }
    }

    const issues = validate(files, demoConfig);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      path: "initiatives/platform/002-broken/initiative.md",
      severity: "error",
    });
  });

  it("reports bad issue syntax, unknown providers, and duplicates", () => {
    const file = initiative({
      path: "initiatives/acme/001-onboarding/initiative.md",
      project: "acme",
      number: "001",
      id: "acme-001",
    });
    if (file.kind !== "initiative") throw new Error("expected an initiative");
    file.frontmatter.issues = ["gh#12", "nope", "linear:ABC-1", "gh#12", "vikunja:4"];
    expect(validate([file], config)).toEqual([
      {
        path: "initiatives/acme/001-onboarding/initiative.md",
        field: "issues",
        message: 'invalid issue ref "nope"',
        severity: "error",
      },
      {
        path: "initiatives/acme/001-onboarding/initiative.md",
        field: "issues",
        message: 'unknown issue provider "linear"',
        severity: "warning",
      },
      {
        path: "initiatives/acme/001-onboarding/initiative.md",
        field: "issues",
        message: 'duplicate issue ref "gh#12"',
        severity: "warning",
      },
    ]);
  });

  it("accepts known issue refs", () => {
    const file = initiative({
      path: "initiatives/acme/003-reports/initiative.md",
      project: "acme",
      number: "003",
      id: "acme-003",
    });
    if (file.kind !== "initiative") throw new Error("expected an initiative");
    file.frontmatter.issues = ["gh#12", "gh:acme/widgets#45", "vikunja:34"];
    expect(validate([file], config)).toEqual([]);
  });
});
