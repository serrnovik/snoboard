import { Graph as DagreGraph, layout as runDagreLayout } from "@dagrejs/dagre";
import type { GraphLabel, NodeLabel } from "@dagrejs/dagre";
import {
  blockedBy,
  blockedChain,
  buildGraph,
  loadConfig,
  type Graph,
  type GraphItem,
} from "snoboard/browser";

export const GRAPH_NODE_WIDTH = 260;
export const GRAPH_NODE_HEIGHT = 88;

const RANK_DIRECTION = "LR";
const RANK_SEPARATION = 64;
const NODE_SEPARATION = 28;
const EDGE_SEPARATION = 12;
const GRAPH_MARGIN = 16;

export type LayoutPhase = {
  id: number;
  title: string;
  status: string;
  depends_on?: readonly number[];
};

export type LayoutItem = {
  id: string;
  title: string;
  status: string;
  depends_on: readonly string[];
  phases?: readonly LayoutPhase[];
};

export type LayoutOptions = {
  includePhases: boolean;
  hideDone: boolean;
  doneStatuses: readonly string[];
  /** Initiative ids that pass the page filters; undefined shows all. */
  visibleInitiatives?: ReadonlySet<string>;
  /** Drop nodes without a visible dependency edge. */
  linkedOnly?: boolean;
};

export type GraphNodeData = {
  id: string;
  label: string;
  title: string;
  status: string;
  kind: "initiative" | "phase";
  initiativeId: string;
  blocked: boolean;
  done: boolean;
};

export type PositionedNode = {
  id: string;
  x: number;
  y: number;
  data: GraphNodeData;
};

export type PositionedEdge = {
  id: string;
  source: string;
  target: string;
  blocked: boolean;
  done: boolean;
};

export type LayoutResult = {
  nodes: PositionedNode[];
  edges: PositionedEdge[];
  /** Initiatives left out by the filters. */
  hidden: number;
};

export function initiativeIdFromNodeId(nodeId: string): string {
  const hashIndex = nodeId.indexOf("#");
  if (hashIndex === -1) return nodeId;
  return nodeId.slice(0, hashIndex);
}

export function layoutGraph(items: readonly LayoutItem[], options: LayoutOptions): LayoutResult {
  const graph = buildInitiativeGraph(items, options.includePhases, options.doneStatuses);
  const doneStatuses = new Set(options.doneStatuses);
  const titles = titleById(items);
  const blockedIds = blockedNodeIds(graph);
  // "Linked" is judged on the whole graph so hiding one endpoint never hides its neighbours.
  const linked = new Set(
    graph.edges.filter((edge) => edge.from !== edge.to).flatMap((edge) => [edge.from, edge.to]),
  );
  const visibleNodes = [...graph.nodes.values()].filter((node) => {
    if (options.hideDone && doneStatuses.has(node.status)) return false;
    if (options.linkedOnly === true && !linked.has(node.id)) return false;
    const allowed = options.visibleInitiatives;
    return allowed === undefined || allowed.has(initiativeIdFromNodeId(node.id));
  });
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const edges = uniqueEdges(visibleEdges(graph, visibleIds, doneStatuses));
  const shownInitiatives = new Set(visibleNodes.map((node) => initiativeIdFromNodeId(node.id)));
  const hidden = items.filter((item) => !shownInitiatives.has(item.id)).length;
  if (visibleNodes.length === 0) return { nodes: [], edges: [], hidden };

  const positions = placeWithDagre(
    visibleNodes.map((node) => node.id),
    edges,
  );
  const nodes = visibleNodes.flatMap((node) => {
    const position = positions.get(node.id);
    if (position === undefined) return [];
    const title = titles.get(node.id) ?? node.id;
    const positioned: PositionedNode = {
      id: node.id,
      x: position.x,
      y: position.y,
      data: {
        id: node.id,
        label: `${node.id} ${title}`,
        title,
        status: node.status,
        kind: node.id.includes("#") ? "phase" : "initiative",
        initiativeId: initiativeIdFromNodeId(node.id),
        blocked: blockedIds.has(node.id),
        done: doneStatuses.has(node.status),
      },
    };
    return [positioned];
  });
  nodes.sort((left, right) => left.id.localeCompare(right.id));
  return { nodes, edges, hidden };
}

export function highlightedNodeIds(
  items: readonly LayoutItem[],
  selectedId: string,
  options: Pick<LayoutOptions, "includePhases" | "doneStatuses">,
): ReadonlySet<string> {
  const graph = buildInitiativeGraph(items, options.includePhases, options.doneStatuses);
  const chain = blockedChain(graph, selectedId);
  const dependents = transitiveDependents(graph, selectedId);
  return new Set([selectedId, ...chain, ...dependents]);
}

function buildInitiativeGraph(
  items: readonly LayoutItem[],
  includePhases: boolean,
  doneStatuses: readonly string[],
): Graph {
  const defaults = loadConfig();
  const statuses = doneStatuses.length > 0 ? [...doneStatuses] : [...defaults.doneStatuses];
  return buildGraph(toGraphItems(items, includePhases), {
    ...defaults,
    doneStatuses: statuses,
  });
}

function toGraphItems(items: readonly LayoutItem[], includePhases: boolean): GraphItem[] {
  return items.map((item) => {
    const graphItem: GraphItem = {
      id: item.id,
      status: item.status,
      depends_on: [...item.depends_on],
    };
    if (!includePhases || item.phases === undefined) return graphItem;
    graphItem.phases = item.phases.map((phase) => ({
      id: phase.id,
      title: phase.title,
      status: phase.status,
      depends_on: phase.depends_on === undefined ? undefined : [...phase.depends_on],
    }));
    return graphItem;
  });
}

function titleById(items: readonly LayoutItem[]): Map<string, string> {
  const titles = new Map<string, string>();
  for (const item of items) {
    titles.set(item.id, item.title);
    for (const phase of item.phases ?? []) {
      titles.set(`${item.id}#${phase.id}`, phase.title);
    }
  }
  return titles;
}

function blockedNodeIds(graph: Graph): Set<string> {
  const blocked = new Set<string>();
  for (const node of graph.nodes.values()) {
    const blockers = blockedBy(graph, node.id);
    if (blockers.length > 0) blocked.add(node.id);
  }
  return blocked;
}

function visibleEdges(
  graph: Graph,
  visibleIds: ReadonlySet<string>,
  doneStatuses: ReadonlySet<string>,
): PositionedEdge[] {
  const edges: PositionedEdge[] = [];
  for (const edge of graph.edges) {
    const sourceIsVisible = visibleIds.has(edge.from);
    const targetIsVisible = visibleIds.has(edge.to);
    const bothEndsVisible = sourceIsVisible && targetIsVisible;
    if (!bothEndsVisible || edge.from === edge.to) continue;
    const source = graph.nodes.get(edge.from);
    const sourceIsDone = source !== undefined && doneStatuses.has(source.status);
    edges.push({
      id: `${edge.from}->${edge.to}`,
      source: edge.from,
      target: edge.to,
      blocked: !sourceIsDone,
      done: sourceIsDone,
    });
  }
  return edges;
}

function uniqueEdges(edges: readonly PositionedEdge[]): PositionedEdge[] {
  const byId = new Map<string, PositionedEdge>();
  for (const edge of edges) {
    if (!byId.has(edge.id)) byId.set(edge.id, edge);
  }
  const unique = [...byId.values()];
  unique.sort((left, right) => left.id.localeCompare(right.id));
  return unique;
}

function transitiveDependents(graph: Graph, id: string): string[] {
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const targets = outgoing.get(edge.from);
    if (targets === undefined) {
      outgoing.set(edge.from, [edge.to]);
      continue;
    }
    targets.push(edge.to);
  }

  const dependents: string[] = [];
  const seen = new Set<string>();
  const pending = [...(outgoing.get(id) ?? [])];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined || seen.has(next)) continue;
    seen.add(next);
    dependents.push(next);
    const children = outgoing.get(next);
    if (children !== undefined) pending.push(...children);
  }
  return dependents;
}

function placeWithDagre(nodeIds: readonly string[], edges: readonly PositionedEdge[]): Map<string, { x: number; y: number }> {
  const dagreGraph = new DagreGraph<GraphLabel, NodeLabel>();
  dagreGraph.setDefaultEdgeLabel(() => ({}));
  dagreGraph.setGraph({
    rankdir: RANK_DIRECTION,
    nodesep: NODE_SEPARATION,
    ranksep: RANK_SEPARATION,
    edgesep: EDGE_SEPARATION,
    marginx: GRAPH_MARGIN,
    marginy: GRAPH_MARGIN,
    ranker: "longest-path",
  });

  const sortedIds = [...nodeIds].sort((left, right) => left.localeCompare(right));
  for (const id of sortedIds) {
    dagreGraph.setNode(id, { width: GRAPH_NODE_WIDTH, height: GRAPH_NODE_HEIGHT });
  }
  for (const edge of edges) {
    dagreGraph.setEdge(edge.source, edge.target);
  }
  runDagreLayout(dagreGraph);

  const positions = new Map<string, { x: number; y: number }>();
  for (const id of sortedIds) {
    const placed = dagreGraph.node(id);
    if (placed.x === undefined || placed.y === undefined) continue;
    positions.set(id, {
      x: Math.round(placed.x - GRAPH_NODE_WIDTH / 2),
      y: Math.round(placed.y - GRAPH_NODE_HEIGHT / 2),
    });
  }
  return positions;
}
