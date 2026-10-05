import { useState, useSyncExternalStore } from "react";
import { parseIcon, resolveIconValue, type DisplayItem } from "./model";
import { Badge } from "@/components/ui/badge";
import { useRepoId } from "@/features/repo/context";
import { repoApi } from "@/lib/routes";
import { cn } from "@/lib/utils";

export { openCountsByProject, parseIcon, resolveIconValue } from "./model";

/** Validated display settings from `.snoboard.yml` (`projects`, `labels`), as sent by the server. */
export type BoardDisplay = {
  projects: Record<string, { icon?: string; name?: string }>;
  labels: Record<string, { icon?: string; color?: string }>;
};

const EMPTY: BoardDisplay = { projects: {}, labels: {} };
const byRepo = new Map<string, BoardDisplay>();
const listeners = new Set<() => void>();

/** Reads `projects` / `labels` from a board or initiative payload; anything malformed is dropped. */
export function readDisplay(value: unknown): BoardDisplay {
  if (typeof value !== "object" || value === null) return EMPTY;
  const record = value as { projects?: unknown; labels?: unknown };
  const projects: BoardDisplay["projects"] = {};
  for (const [key, entry] of entriesOf(record.projects)) {
    const icon = stringField(entry, "icon");
    const name = stringField(entry, "name");
    projects[key] = {
      ...(icon !== undefined && parseIcon(icon) !== undefined ? { icon } : {}),
      ...(name !== undefined ? { name } : {}),
    };
  }
  const labels: BoardDisplay["labels"] = {};
  for (const [key, entry] of entriesOf(record.labels)) {
    const icon = stringField(entry, "icon");
    const color = stringField(entry, "color");
    labels[key] = {
      ...(icon !== undefined && parseIcon(icon)?.kind === "emoji" ? { icon } : {}),
      ...(color !== undefined && color in LABEL_COLOR_CLASS ? { color } : {}),
    };
  }
  return { projects, labels };
}

export function publishDisplay(repoId: string, display: BoardDisplay): void {
  const current = byRepo.get(repoId);
  if (current !== undefined && JSON.stringify(current) === JSON.stringify(display)) return;
  byRepo.set(repoId, display);
  for (const listener of listeners) listener();
}

/** Test helper. */
export function resetDisplay(): void {
  byRepo.clear();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDisplay(): BoardDisplay {
  const repoId = useRepoId();
  return useSyncExternalStore(
    subscribe,
    () => byRepo.get(repoId) ?? EMPTY,
    () => EMPTY,
  );
}

export function iconUrl(repoId: string, path: string): string {
  return repoApi(repoId, `/icons/${encodeURIComponent(path)}`);
}

/**
 * An emoji or a repo image. Images load through the authenticated icon endpoint as `<img>`
 * (an SVG there cannot run scripts); a broken image hides itself.
 */
export function Icon({ value, className, testId }: { value: string | undefined; className?: string; testId?: string }) {
  const repoId = useRepoId();
  const [failed, setFailed] = useState<string | null>(null);
  const parsed = parseIcon(value);
  if (parsed === undefined) return null;
  if (parsed.kind === "emoji") {
    return (
      <span aria-hidden="true" data-testid={testId} className={cn("inline-block shrink-0 leading-none", className)}>
        {parsed.value}
      </span>
    );
  }
  if (failed === parsed.path) return null;
  return (
    <img
      src={iconUrl(repoId, parsed.path)}
      alt=""
      aria-hidden="true"
      data-testid={testId}
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailed(parsed.path)}
      className={cn("inline-block size-4 shrink-0 object-contain", className)}
    />
  );
}

/** Initiative icon, else the project icon, else nothing. */
export function ItemIcon({ item, className, testId }: { item: DisplayItem; className?: string; testId?: string }) {
  const display = useDisplay();
  return <Icon value={resolveIconValue(item, display.projects)} className={className} testId={testId} />;
}

export function ProjectIcon({ project, className }: { project: string; className?: string }) {
  const display = useDisplay();
  return <Icon value={display.projects[project]?.icon} className={className} />;
}

/** Tailwind classes per palette colour (spelled out so the build keeps them). */
export const LABEL_COLOR_CLASS: Record<string, string> = {
  gray: "border-gray-500/40! bg-gray-500/10! text-gray-800! dark:text-gray-200!",
  red: "border-red-500/40! bg-red-500/10! text-red-800! dark:text-red-200!",
  orange: "border-orange-500/40! bg-orange-500/10! text-orange-800! dark:text-orange-200!",
  amber: "border-amber-500/40! bg-amber-500/10! text-amber-800! dark:text-amber-200!",
  yellow: "border-yellow-500/40! bg-yellow-500/10! text-yellow-800! dark:text-yellow-200!",
  lime: "border-lime-500/40! bg-lime-500/10! text-lime-800! dark:text-lime-200!",
  green: "border-green-500/40! bg-green-500/10! text-green-800! dark:text-green-200!",
  teal: "border-teal-500/40! bg-teal-500/10! text-teal-800! dark:text-teal-200!",
  cyan: "border-cyan-500/40! bg-cyan-500/10! text-cyan-800! dark:text-cyan-200!",
  blue: "border-blue-500/40! bg-blue-500/10! text-blue-800! dark:text-blue-200!",
  indigo: "border-indigo-500/40! bg-indigo-500/10! text-indigo-800! dark:text-indigo-200!",
  violet: "border-violet-500/40! bg-violet-500/10! text-violet-800! dark:text-violet-200!",
  purple: "border-purple-500/40! bg-purple-500/10! text-purple-800! dark:text-purple-200!",
  pink: "border-pink-500/40! bg-pink-500/10! text-pink-800! dark:text-pink-200!",
  rose: "border-rose-500/40! bg-rose-500/10! text-rose-800! dark:text-rose-200!",
};

/** Class for a label chip from `labels.<name>.color`, or `undefined` for the default look. */
export function labelColorClass(display: BoardDisplay, label: string): string | undefined {
  const color = display.labels[label]?.color;
  return color === undefined ? undefined : LABEL_COLOR_CLASS[color];
}


function entriesOf(value: unknown): [string, unknown][] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>);
}

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

/** A label chip with its configured emoji and colour. */
export function LabelChip({ label }: { label: string }) {
  const display = useDisplay();
  const icon = display.labels[label]?.icon;
  return (
    <Badge variant="secondary" data-testid={`label-${label}`} className={labelColorClass(display, label)}>
      {icon !== undefined ? <span aria-hidden="true">{icon}</span> : null}
      {label}
    </Badge>
  );
}
