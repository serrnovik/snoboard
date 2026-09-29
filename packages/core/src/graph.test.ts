import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { blockedBy, blockedChain, buildGraph, findCycles, isReady, type GraphItem } from "./graph.js";
import type { Phase } from "./schema.js";

const config = loadConfig();

function phase(id: number, status: string, depends_on?: number[]): Phase {
  return {
    id,
    title: `Phase ${id}`,
    status,
    ...(depends_on ? { depends_on } : {}),
  };
}

function item(
  id: string,
  status: string,
  depends_on: string[] = [],
  phases?: Phase[],
): GraphItem {
  return { id, status, depends_on, ...(phases ? { phases } : {}) };
}

describe("buildGraph", () => {
  it("models a linear chain", () => {
    const items = [
      item("acme-001", "done"),
      item("acme-002", "in-progress", ["acme-001"]),
      item("acme-003", "planned", ["acme-002"]),
    ];
    const graph = buildGraph(items, config);

    expect(findCycles(graph)).toEqual([]);
    expect([...graph.edges]).toEqual([
      { from: "acme-001", to: "acme-002" },
      { from: "acme-002", to: "acme-003" },
    ]);
    expect(isReady(graph, "acme-001")).toBe(false);
    expect(isReady(graph, "acme-002")).toBe(true);
    expect(isReady(graph, "acme-003")).toBe(false);
    expect(blockedBy(graph, "acme-003")).toEqual(["acme-002"]);
    expect(blockedChain(graph, "acme-003")).toEqual(["acme-002"]);

    const open = buildGraph(
      [
        item("acme-001", "planned"),
        item("acme-002", "planned", ["acme-001"]),
        item("acme-003", "planned", ["acme-002"]),
      ],
      config,
    );
    expect(blockedChain(open, "acme-003")).toEqual(["acme-002", "acme-001"]);
    expect(isReady(open, "acme-002")).toBe(false);
  });

  it("models a diamond", () => {
    const ready = buildGraph(
      [
        item("acme-001", "done"),
        item("acme-002", "done", ["acme-001"]),
        item("acme-003", "done", ["acme-001"]),
        item("acme-004", "planned", ["acme-002", "acme-003"]),
      ],
      config,
    );
    expect(findCycles(ready)).toEqual([]);
    expect(isReady(ready, "acme-004")).toBe(true);
    expect(blockedBy(ready, "acme-004")).toEqual([]);

    const waiting = buildGraph(
      [
        item("acme-001", "planned"),
        item("acme-002", "planned", ["acme-001"]),
        item("acme-003", "planned", ["acme-001"]),
        item("acme-004", "planned", ["acme-002", "acme-003"]),
      ],
      config,
    );
    expect(findCycles(waiting)).toEqual([]);
    expect(isReady(waiting, "acme-004")).toBe(false);
    expect(blockedBy(waiting, "acme-004")).toEqual(["acme-002", "acme-003"]);
    expect(blockedChain(waiting, "acme-004")).toEqual(["acme-002", "acme-001", "acme-003"]);
  });

  it("models a phase-level dependency", () => {
    const blocked = buildGraph(
      [
        item("acme-001", "in-progress", [], [phase(1, "done"), phase(2, "in-progress", [1])]),
        item("acme-002", "planned", ["acme-001#2"]),
      ],
      config,
    );
    expect(blocked.nodes.has("acme-001#1")).toBe(true);
    expect(blocked.nodes.has("acme-001#2")).toBe(true);
    expect(blocked.edges).toContainEqual({ from: "acme-001#1", to: "acme-001#2" });
    expect(blocked.edges).toContainEqual({ from: "acme-001#2", to: "acme-002" });
    expect(isReady(blocked, "acme-001#2")).toBe(true);
    expect(isReady(blocked, "acme-002")).toBe(false);
    expect(blockedBy(blocked, "acme-002")).toEqual(["acme-001#2"]);
    expect(findCycles(blocked)).toEqual([]);

    const open = buildGraph(
      [
        item("acme-001", "in-progress", [], [phase(1, "done"), phase(2, "done", [1])]),
        item("acme-002", "planned", ["acme-001#2"]),
      ],
      config,
    );
    expect(isReady(open, "acme-002")).toBe(true);
    expect(blockedBy(open, "acme-002")).toEqual([]);
  });

  it("accepts acme-001#1 and is ready once phase 1 is done", () => {
    const graph = buildGraph(
      [
        item("acme-001", "in-progress", [], [phase(1, "done")]),
        item("acme-002", "planned", ["acme-001#1"]),
      ],
      config,
    );
    expect(graph.nodes.get("acme-001#1")?.status).toBe("done");
    expect(isReady(graph, "acme-002")).toBe(true);
  });

  it("finds a 2-node cycle", () => {
    const graph = buildGraph(
      [
        item("acme-001", "planned", ["acme-002"]),
        item("acme-002", "planned", ["acme-001"]),
      ],
      config,
    );
    expect(findCycles(graph)).toEqual([["acme-001", "acme-002", "acme-001"]]);
    expect(isReady(graph, "acme-001")).toBe(false);
    expect(blockedBy(graph, "acme-001")).toEqual(["acme-002"]);
  });

  it("finds a 3-node cycle", () => {
    const graph = buildGraph(
      [
        item("acme-001", "planned", ["acme-002"]),
        item("acme-002", "planned", ["acme-003"]),
        item("acme-003", "planned", ["acme-001"]),
      ],
      config,
    );
    expect(findCycles(graph)).toEqual([["acme-001", "acme-003", "acme-002", "acme-001"]]);
  });

  it("treats a missing dependency as not done", () => {
    const graph = buildGraph([item("acme-002", "planned", ["acme-999"])], config);
    expect(findCycles(graph)).toEqual([]);
    expect(graph.nodes.has("acme-999")).toBe(false);
    expect(isReady(graph, "acme-002")).toBe(false);
    expect(blockedBy(graph, "acme-002")).toEqual(["acme-999"]);
    expect(blockedChain(graph, "acme-002")).toEqual(["acme-999"]);
  });

  it("does not mutate the input", () => {
    const dependsOn = ["acme-001"];
    const phases = [phase(2, "planned", [1])];
    const items = [item("acme-001", "done"), item("acme-002", "planned", dependsOn, phases)];
    const snapshot = structuredClone(items);
    Object.freeze(dependsOn);
    Object.freeze(phases[0]?.depends_on);
    Object.freeze(phases[0]);
    Object.freeze(phases);
    for (const entry of items) Object.freeze(entry);
    Object.freeze(items);

    expect(() => buildGraph(items, config)).not.toThrow();
    expect(items).toEqual(snapshot);
    expect(items[1]?.depends_on).toBe(dependsOn);
  });
});