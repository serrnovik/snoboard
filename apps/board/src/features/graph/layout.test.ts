import { describe, expect, it } from "vitest";
import {
  highlightedNodeIds,
  layoutGraph,
  type LayoutItem,
  type PositionedNode,
} from "./layout";

const DONE_STATUSES = ["done"];

const demoItems: LayoutItem[] = [
  {
    id: "acme-001",
    title: "Customer onboarding",
    status: "done",
    depends_on: [],
    phases: [
      { id: 1, title: "Account setup", status: "done" },
      { id: 2, title: "First project", status: "done", depends_on: [1] },
    ],
  },
  {
    id: "acme-002",
    title: "Billing",
    status: "in-progress",
    depends_on: ["acme-001"],
  },
  {
    id: "acme-003",
    title: "Reports",
    status: "planned",
    depends_on: ["acme-002"],
  },
];

function xOf(nodes: readonly PositionedNode[], id: string): number {
  const node = nodes.find((entry) => entry.id === id);
  if (node === undefined) throw new Error(`missing node ${id}`);
  return node.x;
}

describe("layoutGraph", () => {
  it("lays the demo chain acme-001 → acme-002 → acme-003 out left to right", () => {
    const layout = layoutGraph(demoItems, {
      includePhases: false,
      hideDone: false,
      doneStatuses: DONE_STATUSES,
    });

    expect(xOf(layout.nodes, "acme-001")).toBeLessThan(xOf(layout.nodes, "acme-002"));
    expect(xOf(layout.nodes, "acme-002")).toBeLessThan(xOf(layout.nodes, "acme-003"));

    const doneEdge = layout.edges.find((edge) => edge.source === "acme-001" && edge.target === "acme-002");
    const blockedEdge = layout.edges.find((edge) => edge.source === "acme-002" && edge.target === "acme-003");
    expect(doneEdge).toMatchObject({ done: true, blocked: false });
    expect(blockedEdge).toMatchObject({ done: false, blocked: true });
  });

  it("highlights the blocked chain when acme-003 is selected", () => {
    const highlighted = highlightedNodeIds(demoItems, "acme-003", {
      includePhases: false,
      doneStatuses: DONE_STATUSES,
    });
    expect(highlighted).toEqual(new Set(["acme-002", "acme-003"]));
  });

  it("adds and removes phase nodes", () => {
    const withPhases = layoutGraph(demoItems, {
      includePhases: true,
      hideDone: false,
      doneStatuses: DONE_STATUSES,
    });
    expect(withPhases.nodes.map((node) => node.id)).toEqual(
      expect.arrayContaining(["acme-001#1", "acme-001#2"]),
    );
    expect(xOf(withPhases.nodes, "acme-001#1")).toBeLessThan(xOf(withPhases.nodes, "acme-001#2"));

    const withoutPhases = layoutGraph(demoItems, {
      includePhases: false,
      hideDone: false,
      doneStatuses: DONE_STATUSES,
    });
    expect(withoutPhases.nodes.some((node) => node.id.includes("#"))).toBe(false);
  });

  it("hides done initiative and phase nodes when hideDone is set", () => {
    const layout = layoutGraph(demoItems, {
      includePhases: true,
      hideDone: true,
      doneStatuses: DONE_STATUSES,
    });
    expect(layout.nodes.map((node) => node.id)).toEqual(["acme-002", "acme-003"]);
    expect(xOf(layout.nodes, "acme-002")).toBeLessThan(xOf(layout.nodes, "acme-003"));
  });

  it("lays out 150 nodes in under 200 ms", () => {
    const items = syntheticChain(150);
    const options = {
      includePhases: false,
      hideDone: true,
      doneStatuses: DONE_STATUSES,
    };
    layoutGraph(items, options);

    const started = performance.now();
    const layout = layoutGraph(items, options);
    const elapsed = performance.now() - started;

    expect(layout.nodes).toHaveLength(150);
    expect(layout.edges).toHaveLength(149);
    expect(xOf(layout.nodes, "item-001")).toBeLessThan(xOf(layout.nodes, "item-150"));
    expect(elapsed).toBeLessThan(200);
  });
});

function syntheticChain(count: number): LayoutItem[] {
  const items: LayoutItem[] = [];
  for (let index = 1; index <= count; index += 1) {
    const id = `item-${String(index).padStart(3, "0")}`;
    const dependsOn = index === 1 ? [] : [`item-${String(index - 1).padStart(3, "0")}`];
    items.push({
      id,
      title: `Item ${index}`,
      status: "planned",
      depends_on: dependsOn,
    });
  }
  return items;
}
