import type { BoardItem } from "snoboard/browser";
import { describe, expect, it } from "vitest";
import { effectiveItems, readinessPending } from "./effective";
import { compareBy, withinAge } from "./columns";

function item(overrides: Partial<BoardItem> & Pick<BoardItem, "id" | "status">): BoardItem {
  return {
    title: overrides.id,
    priority: "p2",
    depends_on: [],
    updated: "2026-09-29",
    path: `initiatives/acme/${overrides.id}/initiative.md`,
    project: "acme",
    number: overrides.id.slice(-3),
    summary: "",
    sourceRef: "main",
    sourceSha: "abc",
    updatedAt: "2026-09-29T00:00:00.000Z",
    isReady: false,
    blockedBy: [],
    onBranches: ["main"],
    ...overrides,
  } as BoardItem;
}

describe("effectiveItems", () => {
  const items = [
    item({ id: "acme-001", status: "in-progress", isReady: true }),
    item({ id: "acme-002", status: "planned", depends_on: ["acme-001"], blockedBy: ["acme-001"] }),
    item({
      id: "acme-003",
      status: "planned",
      depends_on: ["acme-004#1"],
      blockedBy: ["acme-004#1"],
    }),
    item({ id: "acme-004", status: "in-progress", isReady: true, phases: [{ id: 1, title: "One", status: "planned" }] }),
  ];

  it("unblocks dependents when a dependency is done in the basket", () => {
    const effective = effectiveItems(items, [{ kind: "setStatus", id: "acme-001", from: "in-progress", to: "done" }], ["done"]);
    const dependent = effective.find((entry) => entry.id === "acme-002")!;
    expect(dependent.blockedBy).toEqual([]);
    expect(dependent.isReady).toBe(true);
    expect(dependent.committed).toEqual({ status: "planned", isReady: false, blockedBy: ["acme-001"] });
    expect(readinessPending(dependent)).toBe(true);
    const moved = effective.find((entry) => entry.id === "acme-001")!;
    expect(moved.status).toBe("done");
    expect(moved.isReady).toBe(false);
  });

  it("honours pending phase status edits", () => {
    const effective = effectiveItems(items, [{ kind: "setPhaseStatus", id: "acme-004", phase: 1, from: "planned", to: "done" }], ["done"]);
    expect(effective.find((entry) => entry.id === "acme-003")?.blockedBy).toEqual([]);
  });

  it("re-blocks when a done dependency is moved back, and overlays scalar fields", () => {
    const done = [item({ id: "acme-001", status: "done" }), item({ id: "acme-002", status: "planned", depends_on: ["acme-001"], isReady: true })];
    const effective = effectiveItems(
      done,
      [
        { kind: "setStatus", id: "acme-001", from: "done", to: "review" },
        { kind: "setTitle", id: "acme-002", from: "acme-002", to: "Renamed" },
        { kind: "setPriority", id: "acme-002", from: "p2", to: "p0" },
        { kind: "setLabels", id: "acme-002", from: [], to: ["x"] },
      ],
      ["done"],
    );
    const dependent = effective.find((entry) => entry.id === "acme-002")!;
    expect(dependent.blockedBy).toEqual(["acme-001"]);
    expect(dependent).toMatchObject({ title: "Renamed", priority: "p0", labels: ["x"] });
  });

  it("returns the snapshot unchanged with no edits, and ignores createInitiative", () => {
    expect(effectiveItems(items, [], ["done"])).toEqual(items);
    const created = effectiveItems(
      items,
      [{ kind: "createInitiative", project: "acme", slug: "new", title: "New", status: "planned", priority: "p1", depends_on: ["acme-001"] }],
      ["done"],
    );
    expect(created.every((entry) => entry.committed === undefined)).toBe(true);
    expect(created).toHaveLength(items.length);
  });
});

describe("column age and sort", () => {
  const now = Date.parse("2026-09-29T15:00:00.000Z");
  const at = (date: string) => item({ id: "acme-001", status: "done", updated: date, updatedAt: `${date}T00:00:00.000Z` });

  it("filters by whole UTC days", () => {
    expect(withinAge(at("2026-09-28"), "1d", now, new Set())).toBe(true);
    expect(withinAge(at("2026-09-27"), "1d", now, new Set())).toBe(false);
    expect(withinAge(at("2026-09-22"), "1w", now, new Set())).toBe(true);
    expect(withinAge(at("2026-09-15"), "2w", now, new Set())).toBe(true);
    expect(withinAge(at("2026-09-14"), "2w", now, new Set())).toBe(false);
    expect(withinAge(at("2026-08-30"), "1m", now, new Set())).toBe(true);
    expect(withinAge(at("2020-01-01"), "all", now, new Set())).toBe(true);
    expect(withinAge(at("2020-01-01"), "session", now, new Set(["acme-001"]))).toBe(true);
    expect(withinAge(at("2026-09-29"), "session", now, new Set())).toBe(false);
  });

  it("sorts by each mode with stable tie-breaks", () => {
    const list = [
      item({ id: "acme-010", status: "planned", title: "b", priority: "p1", updatedAt: "2026-09-01T00:00:00.000Z", updated: "2026-09-01" }),
      item({ id: "acme-002", status: "planned", title: "B", priority: "p0", updatedAt: "2026-09-20T00:00:00.000Z", updated: "2026-09-20" }),
      item({ id: "acme-003", status: "planned", title: "a", priority: "zz", updatedAt: "2026-09-10T00:00:00.000Z", updated: "2026-09-10" }),
    ];
    const ids = (mode: Parameters<typeof compareBy>[0]) => [...list].sort(compareBy(mode, ["p0", "p1"])).map((entry) => entry.id);
    expect(ids("priority")).toEqual(["acme-002", "acme-010", "acme-003"]);
    expect(ids("changed")).toEqual(["acme-002", "acme-003", "acme-010"]);
    expect(ids("title")).toEqual(["acme-003", "acme-002", "acme-010"]);
    expect(ids("id")).toEqual(["acme-002", "acme-003", "acme-010"]);
  });
});
