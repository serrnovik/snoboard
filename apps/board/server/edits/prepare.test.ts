import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildGraph, buildSnapshot, loadConfig, parseInitiativeFile, validate, type BoardItem, type Config, type Snapshot } from "snoboard";
import { describe, expect, it } from "vitest";
import { createTmpRepo } from "../../../../packages/core/src/test-utils/tmp-repo.ts";
import { prepareEdits, type ReadBlob } from "./prepare.js";

const exec = promisify(execFile);
const TODAY = "2026-10-01";
const config = loadConfig();

function initiative(id: string, title: string, status = "idea"): string {
  return `---
id: ${id}
title: ${title}
status: ${status}
priority: p2
updated: 2026-09-01
---

# ${title}

## Summary

Keep.
`;
}

function boardItem(fields: Pick<BoardItem, "id" | "path" | "number" | "project"> & Partial<BoardItem>): BoardItem {
  return {
    title: "Alpha",
    status: "idea",
    priority: "p2",
    depends_on: [],
    updated: "2026-09-01",
    summary: "Keep.",
    sourceRef: "main",
    sourceSha: "a".repeat(40),
    updatedAt: "2026-09-01T00:00:00.000Z",
    isReady: true,
    blockedBy: [],
    onBranches: [],
    ...fields,
  };
}

function snapshotOf(items: BoardItem[], extra?: Partial<Snapshot>): Snapshot {
  return {
    generatedAt: "2026-10-01T00:00:00.000Z",
    refs: [{ name: "main", sha: "a".repeat(40), isDefault: true }],
    items,
    legacy: [],
    errors: [],
    graph: buildGraph(
      items.map((item) => ({
        id: item.id,
        status: item.status,
        depends_on: [...item.depends_on],
        ...(item.phases === undefined ? {} : { phases: item.phases }),
      })),
      config,
    ),
    ...extra,
  };
}

function blobs(files: Readonly<Record<string, string>>): ReadBlob {
  return async (_ref, filePath) => {
    const text = files[filePath];
    if (text === undefined) return undefined;
    return { sha: `blob-${filePath}`, text };
  };
}

async function git(repoDir: string, args: readonly string[]): Promise<string> {
  const { stdout } = await exec("git", ["--no-pager", ...args], { cwd: repoDir });
  return stdout.trim();
}

describe("prepareEdits", () => {
  const alpha = "initiatives/acme/001-alpha/initiative.md";
  const beta = "initiatives/acme/002-beta/initiative.md";
  const items = [
    boardItem({ id: "acme-001", path: alpha, number: "001", project: "acme", title: "Alpha" }),
    boardItem({ id: "acme-002", path: beta, number: "002", project: "acme", title: "Beta" }),
  ];

  it("accepts a valid batch and returns the base blob sha", async () => {
    const prepared = await prepareEdits(
      [
        { kind: "setStatus", id: "acme-001", from: "idea", to: "planned" },
        { kind: "setPriority", id: "acme-001", from: "p2", to: "p1" },
      ],
      snapshotOf(items),
      blobs({ [alpha]: initiative("acme-001", "Alpha"), [beta]: initiative("acme-002", "Beta") }),
      config,
      TODAY,
    );
    expect(prepared.results).toEqual([
      { index: 0, ok: true, path: alpha },
      { index: 1, ok: true, path: alpha },
    ]);
    expect(prepared.files).toHaveLength(1);
    expect(prepared.files[0]?.path).toBe(alpha);
    expect(prepared.files[0]?.baseSha).toBe(`blob-${alpha}`);
    const text = prepared.files[0]?.text ?? "";
    expect(text).toContain("status: planned");
    expect(text).toContain("priority: p1");
    expect(text).toContain("## Summary\n\nKeep.\n");
    const parsed = parseInitiativeFile(alpha, text, config);
    expect(parsed.kind).toBe("initiative");
    if (parsed.kind !== "initiative") return;
    const errors = validate([parsed], config).filter((issue) => issue.severity === "error");
    expect(errors).toEqual([]);
  });

  it("reports a stale from on that edit and still applies a later edit on another file", async () => {
    const prepared = await prepareEdits(
      [
        { kind: "setStatus", id: "acme-001", from: "done", to: "planned" },
        { kind: "setTitle", id: "acme-002", from: "Beta", to: "Beta two" },
      ],
      snapshotOf(items),
      blobs({ [alpha]: initiative("acme-001", "Alpha"), [beta]: initiative("acme-002", "Beta") }),
      config,
      TODAY,
    );
    expect(prepared.results[0]).toEqual({
      index: 0,
      ok: false,
      error: "acme-001: stale",
      path: alpha,
    });
    expect(prepared.results[1]).toEqual({ index: 1, ok: true, path: beta });
    expect(prepared.files.map((file) => file.path)).toEqual([beta]);
    expect(prepared.files[0]?.text).toContain("title: Beta two");
  });

  it("rejects done while a phase is open, and accepts it once the phase edit comes first", async () => {
    const withPhase = initiative("acme-001", "Alpha", "in-progress").replace(
      "updated: 2026-09-01\n",
      "updated: 2026-09-01\nphases:\n  - id: 3\n    title: Rollout\n    status: in-progress\n",
    );
    const read = blobs({ [alpha]: withPhase });
    const done = { kind: "setStatus" as const, id: "acme-001", from: "in-progress", to: "done" };
    const alone = await prepareEdits([done], snapshotOf(items), read, config, TODAY);
    expect(alone.results[0]?.ok).toBe(false);
    expect(alone.results[0]?.error).toBe('acme-001: phases: phase 3 has status "in-progress" while the initiative is done');

    const fixed = await prepareEdits(
      [{ kind: "setPhaseStatus", id: "acme-001", phase: 3, from: "in-progress", to: "done" }, done],
      snapshotOf(items),
      read,
      config,
      TODAY,
    );
    expect(fixed.results.map((result) => result.ok)).toEqual([true, true]);
  });

  it("applies two edits on one file in order", async () => {
    const prepared = await prepareEdits(
      [
        { kind: "setStatus", id: "acme-001", from: "idea", to: "planned" },
        { kind: "setStatus", id: "acme-001", from: "planned", to: "review" },
      ],
      snapshotOf(items),
      blobs({ [alpha]: initiative("acme-001", "Alpha") }),
      config,
      TODAY,
    );
    expect(prepared.results.map((result) => result.ok)).toEqual([true, true]);
    expect(prepared.files).toHaveLength(1);
    expect(prepared.files[0]?.text).toContain("status: review");
    expect(prepared.files[0]?.text).not.toContain("status: planned");
    expect(prepared.files[0]?.baseSha).toBe(`blob-${alpha}`);
  });

  it("names an unknown initiative instead of failing the batch", async () => {
    const prepared = await prepareEdits(
      [{ kind: "setStatus", id: "acme-009", from: "idea", to: "planned" }],
      snapshotOf(items),
      blobs({}),
      config,
      TODAY,
    );
    expect(prepared.results).toEqual([
      { index: 0, ok: false, error: "unknown initiative acme-009" },
    ]);
    expect(prepared.files).toEqual([]);
  });

  it("assigns the next number past a branch-only initiative, a branch error, and reserved numbers", async () => {
    const numbering = loadConfig("reservedNumbers: [2]\n");
    const repo = await createTmpRepo({
      commits: [
        {
          message: "main",
          files: {
            "initiatives/acme/001-alpha/initiative.md": initiative("acme-001", "Alpha"),
          },
        },
        {
          branch: "initiative/extra",
          message: "branch only",
          files: {
            "initiatives/acme/004-branch/initiative.md": initiative("acme-004", "Branch"),
            "initiatives/acme/006-broken/initiative.md": `---
id: nope
title: Broken
status: idea
priority: p2
updated: 2026-09-01
---

# Broken
`,
          },
        },
      ],
    });
    try {
      const snapshot = await buildSnapshot(repo.dir, numbering);
      const branchOnly = snapshot.items.find((item) => item.id === "acme-004");
      expect(branchOnly?.sourceRef).toBe("initiative/extra");
      expect(snapshot.items.some((item) => item.id === "acme-004" && item.sourceRef === "main")).toBe(false);
      expect(snapshot.errors.some((error) => error.path.endsWith("006-broken/initiative.md"))).toBe(true);

      const head = await git(repo.dir, ["rev-parse", "HEAD"]);
      const status = await git(repo.dir, ["status", "--porcelain"]);
      const prepared = await prepareEdits(
        [
          {
            kind: "createInitiative",
            project: "acme",
            slug: "next",
            title: "Next",
            status: "idea",
            priority: "p2",
          },
          {
            kind: "createInitiative",
            project: "acme",
            slug: "after",
            title: "After",
            status: "idea",
            priority: "p1",
            body: ["---", "id: evil-001", "---", "# After", "", "Typed  *as is*"].join(String.fromCharCode(10)),
          },
        ],
        snapshot,
        async () => {
          throw new Error("createInitiative must not read blobs");
        },
        numbering,
        TODAY,
      );
      expect(prepared.results[0]).toMatchObject({
        index: 0,
        ok: true,
        id: "acme-007",
        number: "007",
        path: "initiatives/acme/007-next/initiative.md",
      });
      expect(prepared.results[1]).toMatchObject({
        index: 1,
        ok: true,
        id: "acme-008",
        number: "008",
        path: "initiatives/acme/008-after/initiative.md",
      });
      expect(prepared.files.map((file) => file.baseSha)).toEqual([null, null]);
      const created = prepared.files[0]?.text ?? "";
      const parsed = parseInitiativeFile(prepared.files[0]?.path ?? "", created, numbering);
      expect(parsed.kind).toBe("initiative");
      const withBody = prepared.files[1]?.text ?? "";
      const parsedWithBody = parseInitiativeFile(prepared.files[1]?.path ?? "", withBody, numbering);
      expect(parsedWithBody.kind === "initiative" && parsedWithBody.frontmatter.id).toBe("acme-008");
      expect(withBody.endsWith(["", "---", "id: evil-001", "---", "# After", "", "Typed  *as is*", ""].join(String.fromCharCode(10)))).toBe(true);
      expect(await git(repo.dir, ["rev-parse", "HEAD"])).toBe(head);
      expect(await git(repo.dir, ["status", "--porcelain"])).toBe(status);
    } finally {
      await repo.remove();
    }
  }, 30_000);
});
