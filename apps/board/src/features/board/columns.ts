import { useCallback, useEffect, useState } from "react";
import type { BoardItem } from "snoboard/browser";

const DAY_MS = 86_400_000;

/** Age window of a closed (done/parked/dropped) column. `session` = only items moved by a pending basket edit. */
export type ClosedAge = "1d" | "1w" | "2w" | "1m" | "all" | "session";
export const DEFAULT_CLOSED_AGE: ClosedAge = "2w";
export const CLOSED_AGE_OPTIONS: readonly { value: ClosedAge; label: string }[] = [
  { value: "1d", label: "1 day" },
  { value: "1w", label: "1 week" },
  { value: "2w", label: "2 weeks" },
  { value: "1m", label: "1 month" },
  { value: "all", label: "All" },
  { value: "session", label: "Only this session's changes" },
];
const AGE_DAYS: Record<Exclude<ClosedAge, "all" | "session">, number> = { "1d": 1, "1w": 7, "2w": 14, "1m": 30 };

export type ColumnSort = "priority" | "changed" | "title" | "id";
export const DEFAULT_COLUMN_SORT: ColumnSort = "priority";
export const COLUMN_SORT_OPTIONS: readonly { value: ColumnSort; label: string }[] = [
  { value: "priority", label: "Priority" },
  { value: "changed", label: "Last changed" },
  { value: "title", label: "Title" },
  { value: "id", label: "Id" },
];

export function isClosedAge(value: unknown): value is ClosedAge {
  return CLOSED_AGE_OPTIONS.some((option) => option.value === value);
}

export function isColumnSort(value: unknown): value is ColumnSort {
  return COLUMN_SORT_OPTIONS.some((option) => option.value === value);
}

/** Newest of frontmatter `updated` (a date) and the last commit time, in ms; 0 when unknown. */
export function lastChangedMs(item: Pick<BoardItem, "updated" | "updatedAt">): number {
  return Math.max(Date.parse(`${item.updated}T00:00:00.000Z`) || 0, Date.parse(item.updatedAt) || 0);
}

/** Whether an item passes a closed column's age window. Ages count whole UTC days, like the old 14-day window. */
export function withinAge(
  item: Pick<BoardItem, "id" | "updated" | "updatedAt">,
  age: ClosedAge,
  now: number,
  pendingIds: ReadonlySet<string>,
): boolean {
  if (age === "all") return true;
  if (age === "session") return pendingIds.has(item.id);
  const touched = lastChangedMs(item);
  if (touched === 0) return false;
  const today = new Date(now);
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const touchedDay = new Date(touched);
  const touchedUtc = Date.UTC(touchedDay.getUTCFullYear(), touchedDay.getUTCMonth(), touchedDay.getUTCDate());
  return Math.round((todayUtc - touchedUtc) / DAY_MS) <= AGE_DAYS[age];
}

export function compareBy(sort: ColumnSort, priorities: readonly string[]) {
  return (left: BoardItem, right: BoardItem): number => {
    switch (sort) {
      case "changed": {
        const byChange = lastChangedMs(right) - lastChangedMs(left);
        return byChange !== 0 ? byChange : left.id.localeCompare(right.id);
      }
      case "title": {
        const byTitle = left.title.localeCompare(right.title, undefined, { sensitivity: "base", numeric: true });
        return byTitle !== 0 ? byTitle : left.id.localeCompare(right.id);
      }
      case "id":
        return left.id.localeCompare(right.id, undefined, { numeric: true });
      case "priority": {
        const byPriority = rank(left.priority, priorities) - rank(right.priority, priorities);
        if (byPriority !== 0) return byPriority;
        const byUpdated = right.updated.localeCompare(left.updated);
        if (byUpdated !== 0) return byUpdated;
        return left.id.localeCompare(right.id);
      }
    }
  };
}

function rank(priority: string, priorities: readonly string[]): number {
  const index = priorities.indexOf(priority);
  return index === -1 ? priorities.length : index;
}

export function closedAgeStorageKey(repoId: string): string {
  return `snoboard:closed-age:v1:${repoId}`;
}

export function columnSortStorageKey(repoId: string): string {
  return `snoboard:column-sort:v1:${repoId}`;
}

function readRecord<T extends string>(key: string, valid: (value: unknown) => value is T): Record<string, T> {
  if (typeof localStorage === "undefined") return {};
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const result: Record<string, T> = {};
    for (const [status, value] of Object.entries(parsed)) if (valid(value)) result[status] = value;
    return result;
  } catch {
    return {};
  }
}

/** Per-column setting persisted per repo. Loaded after mount so SSR markup uses the defaults. */
function useColumnSetting<T extends string>(
  key: string,
  valid: (value: unknown) => value is T,
): { values: Readonly<Record<string, T>>; set: (status: string, value: T) => void } {
  const [values, setValues] = useState<Record<string, T>>({});
  useEffect(() => {
    setValues(readRecord(key, valid));
  }, [key, valid]);
  const set = useCallback(
    (status: string, value: T) => {
      setValues((current) => {
        const next = { ...current, [status]: value };
        if (typeof localStorage !== "undefined") localStorage.setItem(key, JSON.stringify(next));
        return next;
      });
    },
    [key],
  );
  return { values, set };
}

export function useClosedAges(repoId: string) {
  return useColumnSetting(closedAgeStorageKey(repoId), isClosedAge);
}

export function useColumnSorts(repoId: string) {
  return useColumnSetting(columnSortStorageKey(repoId), isColumnSort);
}
