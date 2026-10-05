import {
  detectIconType,
  iconTypeForPath,
  isEmojiIcon,
  isLabelColor,
  MAX_ICON_BYTES,
  parseIcon,
  type Config,
  type Snapshot,
} from "snoboard";
import { readCommittedBytes } from "./repo-sync.js";

/** Display settings the board sends to the browser: only values that passed validation. */
export type BoardDisplay = {
  projects: Record<string, { icon?: string; name?: string }>;
  labels: Record<string, { icon?: string; color?: string }>;
};

export function boardDisplay(config: Config): BoardDisplay {
  const projects: BoardDisplay["projects"] = {};
  for (const [project, display] of Object.entries(config.projects ?? {})) {
    const entry: { icon?: string; name?: string } = {};
    if (parseIcon(display.icon) !== undefined) entry.icon = display.icon as string;
    if (display.name !== undefined) entry.name = display.name;
    if (entry.icon !== undefined || entry.name !== undefined) projects[project] = entry;
  }
  const labels: BoardDisplay["labels"] = {};
  for (const [label, display] of Object.entries(config.labels ?? {})) {
    const entry: { icon?: string; color?: string } = {};
    if (typeof display.icon === "string" && isEmojiIcon(display.icon)) entry.icon = display.icon;
    if (isLabelColor(display.color)) entry.color = display.color;
    if (entry.icon !== undefined || entry.color !== undefined) labels[label] = entry;
  }
  return { projects, labels };
}

/** Headers for every icon answer, including errors. */
const BASE_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
};

/**
 * SVG icons are only ever used as `<img>` sources, where scripts never run. The policy also
 * stops scripts and network loads if someone opens the URL directly.
 */
export const SVG_ICON_CSP = "default-src 'none'; style-src 'unsafe-inline'";

export type IconLookup = { path: string; sha: string };

/**
 * An image icon the config or a frontmatter `icon` names. Project icons are read at the
 * default branch tip; an initiative icon at the commit the board shows for it. Any other
 * path is refused before it reaches git.
 */
export function lookupIcon(snapshot: Snapshot, config: Config, requested: string): IconLookup | undefined {
  const icon = parseIcon(requested);
  if (icon?.kind !== "image") return undefined;
  for (const display of Object.values(config.projects ?? {})) {
    if (display.icon !== requested) continue;
    const sha = snapshot.refs.find((ref) => ref.isDefault)?.sha;
    if (sha !== undefined) return { path: requested, sha };
  }
  const item = snapshot.items.find((entry) => entry.icon === requested);
  if (item !== undefined) return { path: requested, sha: item.sourceSha };
  return undefined;
}

export function iconNotFound(): Response {
  return new Response(JSON.stringify({ error: "not found" }), {
    status: 404,
    headers: {
      ...BASE_HEADERS,
      "Cache-Control": "private, no-store",
      "Content-Type": "application/json; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'",
    },
  });
}

/** Reads the blob (fetched on demand) and answers it when its bytes match the extension. */
export async function iconResponse(repoDir: string, found: IconLookup): Promise<Response> {
  const bytes = await readCommittedBytes(repoDir, found.sha, found.path, MAX_ICON_BYTES).catch(() => undefined);
  if (bytes === undefined) return iconNotFound();
  const type = detectIconType(bytes);
  if (type === undefined || type !== iconTypeForPath(found.path)) return iconNotFound();
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      ...BASE_HEADERS,
      "Content-Type": type,
      "Content-Length": String(bytes.length),
      "Content-Disposition": "inline",
      "Content-Security-Policy": type === "image/svg+xml" ? SVG_ICON_CSP : "default-src 'none'",
      "Cache-Control": "private, max-age=3600",
    },
  });
}
