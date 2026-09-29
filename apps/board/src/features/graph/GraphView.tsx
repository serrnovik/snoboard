import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Background,
  Handle,
  Panel,
  Position,
  ReactFlow,
  useReactFlow,
  type Edge,
  type Node as FlowNode,
  type NodeMouseHandler,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { PageActionsPortal } from "@/components/page-actions";
import { setOpenId } from "@/features/details/open";
import type { BoardPayload } from "@/features/board/model";
import { rateLimitNote, useBoardResource } from "@/features/board/sync";
import { NodeSearch } from "@/components/node-search";
import { ZoomSlider } from "@/components/zoom-slider";
import {
  BaseNode,
  BaseNodeContent,
  BaseNodeHeader,
  BaseNodeHeaderTitle,
} from "@/components/base-node";
import { NodeStatusIndicator, type NodeStatus } from "@/components/node-status-indicator";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  GRAPH_NODE_HEIGHT,
  GRAPH_NODE_WIDTH,
  highlightedNodeIds,
  initiativeIdFromNodeId,
  layoutGraph,
  type GraphNodeData,
  type LayoutItem,
  type LayoutResult,
  type PositionedEdge,
} from "./layout";
import "./graph.css";

const DEFAULT_DONE_STATUSES = ["done"];
const DIMMED_NODE_OPACITY = 0.28;
const DONE_EDGE_OPACITY = 0.45;
const DIMMED_EDGE_OPACITY = 0.16;
const ACTIVE_STATUSES = new Set(["in-progress", "review"]);

type InitiativeFlowNode = FlowNode<GraphNodeData, "initiative">;

const nodeTypes: NodeTypes = { initiative: InitiativeNode };

export default function GraphView({
  refreshTimeoutMs,
}: {
  refreshTimeoutMs?: number;
} = {}) {
  const { phase, payload, loadError, reachError, actionError, rateLimited, refreshing, refresh, retry } =
    useBoardResource({ pollIntervalMs: 0, refreshTimeoutMs });

  let body: ReactNode;
  if (phase === "loading") {
    body = <GraphLoading />;
  } else if (payload === null) {
    body = (
      <GraphMessage
        title="Dependencies unavailable"
        detail={loadError ?? "The board could not be loaded."}
        onRetry={retry}
      />
    );
  } else if (payload.items.length === 0) {
    body = (
      <GraphMessage
        title="No initiatives yet"
        detail="Create one with snoboard new, then refresh the board."
      />
    );
  } else {
    body = <GraphCanvas board={payload} />;
  }

  return (
    <>
      <PageActionsPortal>
        <Button type="button" variant="outline" size="sm" onClick={() => void refresh()} disabled={refreshing}>
          {refreshing ? "Refreshing…" : "Refresh"}
        </Button>
        {rateLimited ? <p className="text-sm text-muted-foreground">{rateLimitNote()}</p> : null}
      </PageActionsPortal>
      <div className="flex h-full min-h-0 flex-col">
        {actionError !== null ? <GraphBanner>{actionError}</GraphBanner> : null}
        {reachError !== null ? <GraphBanner>{reachError}</GraphBanner> : null}
        <div className="min-h-0 flex-1">{body}</div>
      </div>
    </>
  );
}

function GraphBanner({ children }: { children: string }) {
  return (
    <p role="alert" className="border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
      {children}
    </p>
  );
}

function GraphCanvas({ board }: { board: BoardPayload }) {
  const dark = useDocumentDark();
  const [includePhases, setIncludePhases] = useState(false);
  const [hideDone, setHideDone] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const doneStatuses = board.config.doneStatuses ?? DEFAULT_DONE_STATUSES;
  const items = useMemo(() => board.items.map(toLayoutItem), [board.items]);
  const layout = useMemo(
    () => layoutGraph(items, { includePhases, hideDone, doneStatuses }),
    [items, includePhases, hideDone, doneStatuses],
  );
  const highlighted = useMemo(() => {
    if (selectedId === null) return null;
    return highlightedNodeIds(items, selectedId, { includePhases, doneStatuses });
  }, [items, selectedId, includePhases, doneStatuses]);

  useEffect(() => {
    if (selectedId === null) return;
    const stillVisible = layout.nodes.some((node) => node.id === selectedId);
    if (!stillVisible) setSelectedId(null);
  }, [layout, selectedId]);

  const flowNodes = useMemo(
    () => toFlowNodes(layout, selectedId, highlighted),
    [layout, selectedId, highlighted],
  );
  const flowEdges = useMemo(
    () => toFlowEdges(layout.edges, highlighted),
    [layout.edges, highlighted],
  );
  const layoutKey = `${includePhases}:${hideDone}:${layout.nodes.length}`;

  const onNodeClick = useCallback<NodeMouseHandler>(
    (_event, node) => {
      if (selectedId === node.id) {
        openDetails(node.id);
        return;
      }
      setSelectedId(node.id);
    },
    [selectedId],
  );
  const onNodeDoubleClick = useCallback<NodeMouseHandler>((_event, node) => {
    openDetails(node.id);
  }, []);

  return (
    <div className="snoboard-graph relative h-full w-full" aria-label="Dependency graph">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        minZoom={0.02}
        maxZoom={2}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesReconnectable={false}
        elementsSelectable
        zoomOnDoubleClick={false}
        deleteKeyCode={null}
        colorMode={dark ? "dark" : "light"}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onPaneClick={() => setSelectedId(null)}
      >
        <Background />
        <FitViewOnChange layoutKey={layoutKey} />
        <Panel position="top-left" className="flex max-w-[calc(100%-1rem)] flex-wrap items-center gap-2">
          <GraphSearch onSelect={setSelectedId} />
          <div className="flex h-10 items-center gap-3 rounded-lg border bg-card px-3 text-sm text-card-foreground shadow-md">
            <label className="flex items-center gap-2">
              <span>Phases</span>
              <Switch
                size="sm"
                checked={includePhases}
                onCheckedChange={setIncludePhases}
                aria-label="Show phase nodes"
              />
            </label>
            <label className="flex items-center gap-2">
              <span>Hide done</span>
              <Switch
                size="sm"
                checked={hideDone}
                onCheckedChange={setHideDone}
                aria-label="Hide done initiatives"
              />
            </label>
            {selectedId !== null ? (
              <a
                href={`?open=${encodeURIComponent(initiativeIdFromNodeId(selectedId))}`}
                className="font-medium underline-offset-4 hover:underline"
                onClick={(event) => {
                  event.preventDefault();
                  setOpenId(initiativeIdFromNodeId(selectedId));
                }}
              >
                Open {initiativeIdFromNodeId(selectedId)}
              </a>
            ) : null}
          </div>
        </Panel>
        <ZoomSlider position="bottom-left" />
        {layout.nodes.length === 0 ? (
          <Panel position="top-center" className="text-sm text-muted-foreground">
            Nothing to show. Turn off Hide done to include finished initiatives.
          </Panel>
        ) : null}
      </ReactFlow>
    </div>
  );
}

function InitiativeNode({ data }: NodeProps<InitiativeFlowNode>) {
  const detailsHref = detailsPath(data.initiativeId);
  return (
    <NodeStatusIndicator status={indicatorFor(data)}>
      <BaseNode className="h-full w-full">
        <Handle type="target" position={Position.Left} />
        <BaseNodeHeader className="px-3 py-1.5">
          <BaseNodeHeaderTitle className="min-w-0 truncate text-sm">
            <a href={detailsHref} className="nodrag nopan hover:underline" onClick={(event) => event.stopPropagation()}>
              {data.id}
            </a>
          </BaseNodeHeaderTitle>
          <Badge variant="outline">{data.status}</Badge>
        </BaseNodeHeader>
        <BaseNodeContent className="px-3 py-1">
          <p className="truncate text-xs text-muted-foreground">{data.title}</p>
        </BaseNodeContent>
        <Handle type="source" position={Position.Right} />
      </BaseNode>
    </NodeStatusIndicator>
  );
}

function FitViewOnChange({ layoutKey }: { layoutKey: string }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      void fitView({ padding: 0.2, maxZoom: 1, duration: 200 });
    });
    return () => cancelAnimationFrame(frame);
  }, [layoutKey, fitView]);
  return null;
}

function GraphSearch({ onSelect }: { onSelect: (nodeId: string) => void }) {
  const { fitView } = useReactFlow();
  return (
    <NodeSearch
      onSelectNode={(node) => {
        onSelect(node.id);
        void fitView({ nodes: [{ id: node.id }], padding: 0.4, duration: 400 });
      }}
    />
  );
}

function GraphLoading() {
  return (
    <div className="flex h-full flex-col gap-3 p-6" aria-busy="true" aria-live="polite">
      <Skeleton className="h-10 w-72" />
      <Skeleton className="min-h-0 flex-1" />
    </div>
  );
}

function GraphMessage({
  title,
  detail,
  onRetry,
}: {
  title: string;
  detail: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <Card className="max-w-md">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{detail}</CardDescription>
        </CardHeader>
        {onRetry !== undefined ? (
          <div className="px-4 pb-4">
            <Button type="button" variant="outline" onClick={onRetry}>
              Retry
            </Button>
          </div>
        ) : null}
      </Card>
    </div>
  );
}

function useDocumentDark(): boolean {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setDark(root.classList.contains("dark"));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

function toLayoutItem(item: BoardPayload["items"][number]): LayoutItem {
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    depends_on: item.depends_on,
    phases: item.phases,
  };
}

function toFlowNodes(
  layout: LayoutResult,
  selectedId: string | null,
  highlighted: ReadonlySet<string> | null,
): InitiativeFlowNode[] {
  return layout.nodes.map((node) => {
    const dimmed = highlighted !== null && !highlighted.has(node.id);
    const flowNode: InitiativeFlowNode = {
      id: node.id,
      type: "initiative",
      position: { x: node.x, y: node.y },
      data: node.data,
      selected: node.id === selectedId,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      style: {
        width: GRAPH_NODE_WIDTH,
        height: GRAPH_NODE_HEIGHT,
        opacity: dimmed ? DIMMED_NODE_OPACITY : 1,
      },
    };
    return flowNode;
  });
}

function toFlowEdges(edges: readonly PositionedEdge[], highlighted: ReadonlySet<string> | null): Edge[] {
  return edges.map((edge) => {
    const endpointsHighlighted =
      highlighted !== null && highlighted.has(edge.source) && highlighted.has(edge.target);
    const dimmed = highlighted !== null && !endpointsHighlighted;
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      style: edgeStyle(edge, dimmed),
    };
  });
}

function edgeStyle(edge: PositionedEdge, dimmed: boolean): { stroke: string; strokeDasharray?: string; opacity: number } {
  if (edge.blocked) {
    return {
      stroke: "var(--destructive)",
      strokeDasharray: "6 4",
      opacity: dimmed ? DIMMED_EDGE_OPACITY : 1,
    };
  }
  return {
    stroke: "var(--muted-foreground)",
    opacity: dimmed ? DIMMED_EDGE_OPACITY : DONE_EDGE_OPACITY,
  };
}

function indicatorFor(data: GraphNodeData): NodeStatus {
  if (data.done) return "success";
  if (data.blocked) return "error";
  if (ACTIVE_STATUSES.has(data.status)) return "loading";
  return "initial";
}

function detailsPath(nodeId: string): string {
  return `/initiatives/${initiativeIdFromNodeId(nodeId)}`;
}

function openDetails(nodeId: string): void {
  setOpenId(initiativeIdFromNodeId(nodeId));
}
