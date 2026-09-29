import type { Config } from "./config.js";
import type { Phase } from "./schema.js";

export type GraphNode = {
  readonly id: string;
  readonly status: string;
  readonly dependsOn: readonly string[];
};

export type GraphEdge = {
  readonly from: string;
  readonly to: string;
};

export type Graph = {
  readonly nodes: ReadonlyMap<string, GraphNode>;
  readonly edges: readonly GraphEdge[];
  readonly doneStatuses: readonly string[];
};

export type GraphItem = {
  id: string;
  status: string;
  depends_on: string[];
  phases?: Phase[];
};

function isDone(graph: Graph, id: string): boolean {
  const node = graph.nodes.get(id);
  if (!node) return false;
  return graph.doneStatuses.includes(node.status);
}

export function buildGraph(items: readonly GraphItem[], config: Config): Graph {
  const nodes = new Map<string, GraphNode>();
  for (const item of items) {
    if (!nodes.has(item.id)) {
      nodes.set(item.id, {
        id: item.id,
        status: item.status,
        dependsOn: [...item.depends_on],
      });
    }
    for (const phase of item.phases ?? []) {
      const phaseId = `${item.id}#${phase.id}`;
      if (nodes.has(phaseId)) continue;
      nodes.set(phaseId, {
        id: phaseId,
        status: phase.status,
        dependsOn: (phase.depends_on ?? []).map((dependency) => `${item.id}#${dependency}`),
      });
    }
  }

  const edges: GraphEdge[] = [];
  for (const node of nodes.values()) {
    for (const dependency of node.dependsOn) {
      edges.push({ from: dependency, to: node.id });
    }
  }

  return {
    nodes,
    edges,
    doneStatuses: [...config.doneStatuses],
  };
}

export function findCycles(graph: Graph): string[][] {
  const adjacent = new Map<string, string[]>();
  for (const node of graph.nodes.values()) adjacent.set(node.id, []);
  for (const edge of graph.edges) {
    if (!adjacent.has(edge.from)) adjacent.set(edge.from, []);
    if (!adjacent.has(edge.to)) adjacent.set(edge.to, []);
    adjacent.get(edge.from)?.push(edge.to);
  }

  const cycles: string[][] = [];
  const seen = new Set<string>();
  const visiting = new Set<string>();
  const finished = new Set<string>();
  const stack: string[] = [];

  function record(path: string[]): void {
    const body = path.slice(0, -1);
    if (body.length === 0) return;
    let start = 0;
    for (let index = 1; index < body.length; index += 1) {
      if (body[index]! < body[start]!) start = index;
    }
    const rotated = body.slice(start).concat(body.slice(0, start));
    const key = rotated.join("\0");
    if (seen.has(key)) return;
    seen.add(key);
    cycles.push([...rotated, rotated[0]!]);
  }

  function visit(id: string): void {
    visiting.add(id);
    stack.push(id);
    for (const next of adjacent.get(id) ?? []) {
      if (visiting.has(next)) {
        const start = stack.indexOf(next);
        if (start >= 0) record([...stack.slice(start), next]);
        continue;
      }
      if (!finished.has(next)) visit(next);
    }
    stack.pop();
    visiting.delete(id);
    finished.add(id);
  }

  for (const id of [...adjacent.keys()].sort()) {
    if (!finished.has(id)) visit(id);
  }

  cycles.sort((left, right) => left.join("\0").localeCompare(right.join("\0")));
  return cycles;
}

export function isReady(graph: Graph, id: string): boolean {
  const node = graph.nodes.get(id);
  if (!node) return false;
  if (graph.doneStatuses.includes(node.status)) return false;
  return node.dependsOn.every((dependency) => isDone(graph, dependency));
}

export function blockedBy(graph: Graph, id: string): string[] {
  const node = graph.nodes.get(id);
  if (!node) return [];
  return node.dependsOn.filter((dependency) => !isDone(graph, dependency));
}

export function blockedChain(graph: Graph, id: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();

  const visit = (current: string): void => {
    const node = graph.nodes.get(current);
    for (const dependency of node?.dependsOn ?? []) {
      if (isDone(graph, dependency) || seen.has(dependency)) continue;
      seen.add(dependency);
      chain.push(dependency);
      visit(dependency);
    }
  };

  visit(id);
  return chain;
}