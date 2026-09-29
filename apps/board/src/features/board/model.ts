import type { BoardItem, LegacyItem, ParsedFileError, RefInfo } from "snoboard/browser";

export const DONE_WINDOW_DAYS = 14;

export type BoardStatus = {
  lastFetchAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  refreshing: boolean;
};

export type BoardConfig = {
  statuses: string[];
  priorities: string[];
  doneStatuses: string[];
};

export type BoardPayload = {
  status: BoardStatus;
  config: BoardConfig;
  items: BoardItem[];
  legacy: LegacyItem[];
  errors: ParsedFileError[];
  refs: RefInfo[];
};

export type BoardQuery = {
  project: string | null;
  label: string | null;
  priority: string | null;
  search: string;
  showLegacy: boolean;
  showAllDone: boolean;
};

export function emptyBoardQuery(): BoardQuery {
  return {
    project: null,
    label: null,
    priority: null,
    search: "",
    showLegacy: false,
    showAllDone: false,
  };
}

export function parseBoardQuery(search: string): BoardQuery {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return {
    project: present(params.get("project")),
    label: present(params.get("label")),
    priority: present(params.get("priority")),
    search: params.get("q") ?? "",
    showLegacy: params.get("legacy") === "1",
    showAllDone: params.get("done") === "all",
  };
}

export function serializeBoardQuery(currentSearch: string, next: BoardQuery): string {
  const params = new URLSearchParams(
    currentSearch.startsWith("?") ? currentSearch.slice(1) : currentSearch,
  );
  assign(params, "project", next.project);
  assign(params, "label", next.label);
  assign(params, "priority", next.priority);
  assign(params, "q", next.search.length > 0 ? next.search : null);
  assign(params, "legacy", next.showLegacy ? "1" : null);
  assign(params, "done", next.showAllDone ? "all" : null);
  const query = params.toString();
  return query.length === 0 ? "" : `?${query}`;
}

export function isBoardPayload(value: unknown): value is BoardPayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const config = record.config;
  const status = record.status;
  if (typeof config !== "object" || config === null) return false;
  if (typeof status !== "object" || status === null) return false;
  const configRecord = config as Record<string, unknown>;
  return (
    Array.isArray(record.items) &&
    Array.isArray(record.legacy) &&
    Array.isArray(record.refs) &&
    Array.isArray(configRecord.statuses) &&
    Array.isArray(configRecord.priorities) &&
    Array.isArray(configRecord.doneStatuses)
  );
}

export function compareBoardItems(
  left: BoardItem,
  right: BoardItem,
  priorities: readonly string[],
): number {
  const byPriority = priorityRank(left.priority, priorities) - priorityRank(right.priority, priorities);
  if (byPriority !== 0) return byPriority;
  const byUpdated = right.updated.localeCompare(left.updated);
  if (byUpdated !== 0) return byUpdated;
  return left.id.localeCompare(right.id);
}

export function matchesFilters(item: BoardItem, query: BoardQuery): boolean {
  if (query.project !== null && item.project !== query.project) return false;
  if (query.priority !== null && item.priority !== query.priority) return false;
  if (query.label !== null && !(item.labels ?? []).includes(query.label)) return false;
  const needle = query.search.trim().toLowerCase();
  if (needle.length === 0) return true;
  return `${item.id} ${item.title}`.toLowerCase().includes(needle);
}

export function isWithinDoneWindow(updated: string, now: number): boolean {
  const updatedMs = Date.parse(`${updated}T00:00:00.000Z`);
  if (Number.isNaN(updatedMs)) return false;
  const today = new Date(now);
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const ageDays = Math.round((todayUtc - updatedMs) / 86_400_000);
  return ageDays <= DONE_WINDOW_DAYS;
}

export function visibleColumnItems(
  items: readonly BoardItem[],
  status: string,
  doneStatuses: readonly string[],
  priorities: readonly string[],
  showAllDone: boolean,
  now: number,
): { visible: BoardItem[]; hidden: number } {
  const matching = items
    .filter((item) => item.status === status)
    .sort((left, right) => compareBoardItems(left, right, priorities));
  if (!doneStatuses.includes(status) || showAllDone) {
    return { visible: matching, hidden: 0 };
  }
  const visible = matching.filter((item) => isWithinDoneWindow(item.updated, now));
  return { visible, hidden: matching.length - visible.length };
}

export function priorityVariant(priority: string): "destructive" | "default" | "outline" {
  if (priority === "p0") return "destructive";
  if (priority === "p1") return "default";
  return "outline";
}

export function phaseProgress(
  item: BoardItem,
  doneStatuses: readonly string[],
): { done: number; total: number } | null {
  const phases = item.phases;
  if (phases === undefined || phases.length === 0) return null;
  const done = phases.filter((phase) => doneStatuses.includes(phase.status)).length;
  return { done, total: phases.length };
}

export function defaultBranchName(refs: readonly RefInfo[]): string | null {
  return refs.find((ref) => ref.isDefault)?.name ?? null;
}

export function showsBranchBadge(sourceRef: string, defaultBranch: string | null): boolean {
  if (defaultBranch === null) return false;
  return sourceRef !== defaultBranch;
}

export function formatRelativeTime(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const deltaSeconds = Math.round((then - now) / 1000);
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 60 * 60 * 24 * 365],
    ["month", 60 * 60 * 24 * 30],
    ["week", 60 * 60 * 24 * 7],
    ["day", 60 * 60 * 24],
    ["hour", 60 * 60],
    ["minute", 60],
    ["second", 1],
  ];
  for (const [unit, seconds] of units) {
    if (Math.abs(deltaSeconds) >= seconds || unit === "second") {
      return formatter.format(Math.round(deltaSeconds / seconds), unit);
    }
  }
  return formatter.format(0, "second");
}

export function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function present(value: string | null): string | null {
  if (value === null || value.length === 0) return null;
  return value;
}

function assign(params: URLSearchParams, key: string, value: string | null): void {
  if (value === null || value.length === 0) params.delete(key);
  else params.set(key, value);
}

function priorityRank(priority: string, priorities: readonly string[]): number {
  const index = priorities.indexOf(priority);
  return index === -1 ? priorities.length : index;
}
