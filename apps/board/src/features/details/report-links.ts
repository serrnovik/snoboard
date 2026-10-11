import type { BoardItem } from "snoboard/browser";

export type Report = NonNullable<BoardItem["reports"]>[number];

/** Reports of an initiative, split into initiative-level ones and those of each phase id. */
export function splitReports(item: Pick<BoardItem, "reports" | "phases">): {
  initiative: Report[];
  byPhase: Map<number, Report[]>;
} {
  const phaseIds = new Set((item.phases ?? []).map((phase) => phase.id));
  const initiative: Report[] = [];
  const byPhase = new Map<number, Report[]>();
  for (const report of item.reports ?? []) {
    if (report.phase !== undefined && phaseIds.has(report.phase)) {
      const list = byPhase.get(report.phase) ?? [];
      list.push(report);
      byPhase.set(report.phase, list);
    } else {
      initiative.push(report);
    }
  }
  return { initiative, byPhase };
}

/** Dialog order: initiative-level reports first, then each phase's in phase order. */
export function orderedReports(item: Pick<BoardItem, "reports" | "phases">): Report[] {
  const { initiative, byPhase } = splitReports(item);
  const phases = [...byPhase.keys()].sort((left, right) => left - right);
  return [...initiative, ...phases.flatMap((phase) => byPhase.get(phase) ?? [])];
}

/** Short chip label: `phase-2.review-plan` -> `review-plan`, `phase-2.report` -> `report`. */
export function phaseChipLabel(name: string): string {
  const rest = name.replace(/^phase-\d+[.-]?/, "");
  return rest.length === 0 ? "report" : rest;
}
