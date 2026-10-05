import type { BoardItem, InitiativePeople, LegacyItem, ParsedFileError, RefInfo } from "snoboard/browser";
import {
  compareBy,
  DEFAULT_CLOSED_AGE,
  DEFAULT_COLUMN_SORT,
  withinAge,
  type ClosedAge,
  type ColumnSort,
} from "@/features/board/columns";

export const DONE_WINDOW_DAYS = 14;
export const DEFAULT_STALE_AFTER_DAYS = 30;
const DAY_MS = 86_400_000;
// Same exemption as `snoboard validate` / `status --stale`: these may sit untouched.
const STALE_EXEMPT = new Set(["parked", "dropped"]);

/** Closed = done statuses plus parked/dropped. Closed columns show recent items by default. */
export function isClosedStatus(status: string, doneStatuses: readonly string[]): boolean {
  return doneStatuses.includes(status) || STALE_EXEMPT.has(status);
}

/**
 * Which closed columns show every item. URL: `closed=all` (every closed column) or
 * `closed=parked,dropped` (per column). The older `done=all` still means "all".
 */
export type ShowAllClosed = "all" | string[];

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
  staleAfterDays?: number;
  /** Validated `.snoboard.yml` display settings (icons, names, label colours). */
  projects?: Record<string, { icon?: string; name?: string }>;
  labels?: Record<string, { icon?: string; color?: string }>;
};

export type ProposalField = {
  field: string;
  value: string;
};

export type Proposal = {
  branch: string;
  initiativeId: string;
  fields: ProposalField[];
  pr?: { number: number; url: string };
};

export type BoardPayload = {
  status: BoardStatus;
  config: BoardConfig;
  items: BoardItem[];
  legacy: LegacyItem[];
  errors: ParsedFileError[];
  refs: RefInfo[];
  proposals?: Proposal[];
  /** Creator and participants per initiative id (one git walk per snapshot). */
  people?: Record<string, InitiativePeople>;
};

export type BoardQuery = {
  project: string | null;
  label: string | null;
  priority: string | null;
  search: string;
  showLegacy: boolean;
  showAllClosed: ShowAllClosed;
  hideStale: boolean;
};

export function emptyBoardQuery(): BoardQuery {
  return {
    project: null,
    label: null,
    priority: null,
    search: "",
    showLegacy: false,
    showAllClosed: [],
    hideStale: false,
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
    showAllClosed: parseShowAllClosed(params),
    hideStale: params.get("stale") === "hide",
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
  params.delete("done");
  assign(
    params,
    "closed",
    next.showAllClosed === "all" ? "all" : next.showAllClosed.length > 0 ? next.showAllClosed.join(",") : null,
  );
  assign(params, "stale", next.hideStale ? "hide" : null);
  const query = params.toString();
  return query.length === 0 ? "" : `?${query}`;
}

function parseShowAllClosed(params: URLSearchParams): ShowAllClosed {
  const closed = params.get("closed");
  if (params.get("done") === "all" || closed === "all") return "all";
  if (closed === null) return [];
  return uniqueSorted(closed.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0));
}

export function showsAllClosed(showAllClosed: ShowAllClosed, status: string): boolean {
  return showAllClosed === "all" || showAllClosed.includes(status);
}

/** Toggle one closed column between "show all" and "show recent". */
export function toggleShowAllClosed(
  showAllClosed: ShowAllClosed,
  status: string,
  closedStatuses: readonly string[],
): ShowAllClosed {
  const current = showAllClosed === "all" ? [...closedStatuses] : showAllClosed;
  const next = current.includes(status) ? current.filter((entry) => entry !== status) : [...current, status];
  const sorted = uniqueSorted(next);
  return closedStatuses.length > 0 && closedStatuses.every((entry) => sorted.includes(entry)) ? "all" : sorted;
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

/**
 * An open initiative is stale when neither its `updated` date nor its last commit
 * is newer than `staleAfterDays`. Done, parked and dropped initiatives are never stale.
 */
export function isStale(
  item: Pick<BoardItem, "status" | "updated" | "updatedAt">,
  doneStatuses: readonly string[],
  staleAfterDays: number,
  now: number,
): boolean {
  if (doneStatuses.includes(item.status) || STALE_EXEMPT.has(item.status)) return false;
  const touched = Math.max(
    Date.parse(`${item.updated}T00:00:00.000Z`) || 0,
    Date.parse(item.updatedAt) || 0,
  );
  if (touched === 0) return false;
  return now - touched > staleAfterDays * DAY_MS;
}

export function isWithinDoneWindow(updated: string, now: number): boolean {
  const updatedMs = Date.parse(`${updated}T00:00:00.000Z`);
  if (Number.isNaN(updatedMs)) return false;
  const today = new Date(now);
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const ageDays = Math.round((todayUtc - updatedMs) / 86_400_000);
  return ageDays <= DONE_WINDOW_DAYS;
}

/** Last change = max of frontmatter `updated` and the last commit `updatedAt`, within 14 days. */
export function isRecentlyChanged(item: Pick<BoardItem, "updated" | "updatedAt">, now: number): boolean {
  const touched = Math.max(
    Date.parse(`${item.updated}T00:00:00.000Z`) || 0,
    Date.parse(item.updatedAt) || 0,
  );
  if (touched === 0) return false;
  return isWithinDoneWindow(new Date(touched).toISOString().slice(0, 10), now);
}

export function visibleColumnItems(
  items: readonly BoardItem[],
  status: string,
  doneStatuses: readonly string[],
  priorities: readonly string[],
  showAll: boolean,
  now: number,
  options: { age?: ClosedAge; sort?: ColumnSort; pendingIds?: ReadonlySet<string> } = {},
): { visible: BoardItem[]; hidden: number; closed: boolean } {
  const matching = items
    .filter((item) => item.status === status)
    .sort(compareBy(options.sort ?? DEFAULT_COLUMN_SORT, priorities));
  const closed = isClosedStatus(status, doneStatuses);
  const age: ClosedAge = showAll ? "all" : (options.age ?? DEFAULT_CLOSED_AGE);
  if (!closed || age === "all") {
    return { visible: matching, hidden: 0, closed };
  }
  const pendingIds = options.pendingIds ?? new Set<string>();
  const visible = matching.filter((item) => withinAge(item, age, now, pendingIds));
  return { visible, hidden: matching.length - visible.length, closed };
}

const PRIORITY_MEANINGS: Record<string, string> = {
  p0: "urgent",
  p1: "high",
  p2: "normal",
  p3: "low",
};

/** "p0 · urgent" for the default scale; unknown priorities stay as-is. */
export function priorityLabel(priority: string): string {
  const meaning = PRIORITY_MEANINGS[priority];
  return meaning === undefined ? priority : `${priority} · ${meaning}`;
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

export function readProposals(value: unknown): Proposal[] {
  if (!Array.isArray(value)) return [];
  const proposals: Proposal[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.branch !== "string" || typeof entry.initiativeId !== "string") continue;
    if (!Array.isArray(entry.fields)) continue;
    const fields: ProposalField[] = [];
    for (const field of entry.fields) {
      if (!isRecord(field) || typeof field.field !== "string" || typeof field.value !== "string") continue;
      fields.push({ field: field.field, value: field.value });
    }
    if (fields.length === 0) continue;
    const proposal: Proposal = { branch: entry.branch, initiativeId: entry.initiativeId, fields };
    if (
      isRecord(entry.pr) &&
      typeof entry.pr.number === "number" &&
      Number.isInteger(entry.pr.number) &&
      entry.pr.number > 0 &&
      typeof entry.pr.url === "string" &&
      entry.pr.url.startsWith("https://")
    ) {
      proposal.pr = { number: entry.pr.number, url: entry.pr.url };
    }
    proposals.push(proposal);
  }
  return proposals;
}

export function proposalsFor(proposals: readonly Proposal[], id: string): Proposal[] {
  return proposals.filter((proposal) => proposal.initiativeId === id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
