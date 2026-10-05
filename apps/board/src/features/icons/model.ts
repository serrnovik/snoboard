import { parseIcon, resolveIcon } from "snoboard/browser";
import { isClosedStatus } from "@/features/board/model";

export { parseIcon };

export type DisplayItem = { icon?: unknown; project: string };

/** Initiative icon, else the project icon from `.snoboard.yml`, else `undefined`. */
export function resolveIconValue(
  item: DisplayItem,
  projects: Readonly<Record<string, { icon?: string } | undefined>>,
): string | undefined {
  const icon = resolveIcon(item, projects);
  if (icon === undefined) return undefined;
  return icon.kind === "emoji" ? icon.value : icon.path;
}

/**
 * Open initiatives per project: not in a done status, `parked` or `dropped`. Every project in
 * `projects` gets an entry, so projects with nothing open show 0.
 */
export function openCountsByProject(
  items: readonly { project: string; status: string }[],
  doneStatuses: readonly string[],
  projects: readonly string[] = [],
): Map<string, number> {
  const counts = new Map<string, number>(projects.map((project) => [project, 0]));
  for (const item of items) {
    const open = isClosedStatus(item.status, doneStatuses) ? 0 : 1;
    counts.set(item.project, (counts.get(item.project) ?? 0) + open);
  }
  return counts;
}
