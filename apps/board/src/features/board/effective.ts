import { blockedBy, buildGraph, isReady, loadConfig, type BoardItem, type Edit } from "snoboard/browser";

/** Committed values of fields a pending basket edit changed. */
export type CommittedState = {
  status: string;
  isReady: boolean;
  blockedBy: string[];
};

/**
 * A board item as it will look once the basket is submitted. `committed` is set
 * only when the pending edits change status, readiness or blockers.
 */
export type EffectiveItem = BoardItem & { committed?: CommittedState };

/**
 * Overlay pending basket edits on the snapshot and recompute blocked/ready with the
 * same core graph logic the server uses. `createInitiative` edits add no node here:
 * a new initiative cannot yet be a dependency of an existing one, so it never changes
 * another card's blocked state.
 */
export function effectiveItems(
  items: readonly BoardItem[],
  edits: readonly Edit[],
  doneStatuses: readonly string[],
): EffectiveItem[] {
  if (edits.length === 0) return [...items];
  const overlaid = items.map((item) => overlay(item, edits));
  const defaults = loadConfig();
  const graph = buildGraph(
    overlaid.map((item) => ({
      id: item.id,
      status: item.status,
      depends_on: [...(item.depends_on ?? [])],
      phases: item.phases,
    })),
    { ...defaults, doneStatuses: doneStatuses.length > 0 ? [...doneStatuses] : defaults.doneStatuses },
  );
  return overlaid.map((item, index) => {
    const original = items[index]!;
    const next: EffectiveItem = {
      ...item,
      isReady: isReady(graph, item.id),
      blockedBy: blockedBy(graph, item.id),
    };
    if (
      next.status !== original.status ||
      next.isReady !== original.isReady ||
      !sameList(next.blockedBy, original.blockedBy)
    ) {
      next.committed = { status: original.status, isReady: original.isReady, blockedBy: [...original.blockedBy] };
    }
    return next;
  });
}

function overlay(item: BoardItem, edits: readonly Edit[]): BoardItem {
  let next = item;
  for (const edit of edits) {
    if (edit.kind === "createInitiative" || edit.kind === "addAttachment" || edit.id !== item.id) continue;
    switch (edit.kind) {
      case "setStatus":
        next = { ...next, status: edit.to };
        break;
      case "setPriority":
        next = { ...next, priority: edit.to };
        break;
      case "setTitle":
        next = { ...next, title: edit.to };
        break;
      case "setLabels":
        next = { ...next, labels: [...edit.to] };
        break;
      case "setIssues":
        next = { ...next, issues: [...edit.to] };
        break;
      case "setLinks":
        next = { ...next, links: edit.to.map((link) => ({ ...link })) };
        break;
      case "setPhaseStatus":
        next = {
          ...next,
          phases: (next.phases ?? []).map((phase) => (phase.id === edit.phase ? { ...phase, status: edit.to } : phase)),
        };
        break;
      case "setBody":
        break;
    }
  }
  return next;
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

/** "blocked", "ready" or null, for the effective or the committed state. */
export function readiness(state: { isReady: boolean; blockedBy: readonly string[] }): "blocked" | "ready" | null {
  if (state.blockedBy.length > 0) return "blocked";
  return state.isReady ? "ready" : null;
}

/** True when the pending basket changes whether the card shows blocked/ready. */
export function readinessPending(item: EffectiveItem): boolean {
  return item.committed !== undefined && readiness(item.committed) !== readiness(item);
}
