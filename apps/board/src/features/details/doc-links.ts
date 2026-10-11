import { ASSET_PATH, type BoardItem } from "snoboard/browser";
import { assetUrl } from "@/features/attachments/images";
import { repoApi } from "@/lib/routes";
import { forgeFileUrl, type ForgeLinkConfig } from "./links.js";
import { orderedReports } from "./report-links.js";

export type DocFormat = "md" | "html";
export type DocEntry = NonNullable<BoardItem["docs"]>[number];
type DocItem = Pick<BoardItem, "docs" | "reports" | "phases">;

/**
 * One file the viewer can show. `key` is the path below the initiative folder without the
 * extension (`ROADMAP`, `phases/phase-1.packet`, `reports/final.report`).
 */
export type ViewerDoc = {
  key: string;
  kind: DocEntry["kind"] | "report";
  formats: DocFormat[];
  title: string;
  phase?: number;
  /** Navigation group: `Initiative`, `Phase <n>` or `Reports`. */
  group: string;
};

const IMAGE = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,127}\/){0,3}[A-Za-z0-9_][A-Za-z0-9._-]{0,127}\.(?:png|jpe?g|webp|gif)$/;

function phaseIds(item: Pick<BoardItem, "phases">): number[] {
  return (item.phases ?? []).map((phase) => phase.id);
}

/** Documents (not reports) of an initiative split into initiative-level ones and those of each phase id. */
export function splitDocs(item: Pick<BoardItem, "docs" | "phases">): {
  initiative: DocEntry[];
  byPhase: Map<number, DocEntry[]>;
} {
  const known = new Set(phaseIds(item));
  const initiative: DocEntry[] = [];
  const byPhase = new Map<number, DocEntry[]>();
  for (const doc of item.docs ?? []) {
    if (doc.phase !== undefined && known.has(doc.phase)) {
      const list = byPhase.get(doc.phase) ?? [];
      list.push(doc);
      byPhase.set(doc.phase, list);
    } else {
      initiative.push(doc);
    }
  }
  // Packets and other phase files before the task files of the phase.
  for (const list of byPhase.values()) list.sort((left, right) => Number(left.kind === "task") - Number(right.kind === "task"));
  return { initiative, byPhase };
}

/** Viewer order (and nav groups): Initiative, then Phase N in phase order, then Reports. */
export function viewerDocs(item: DocItem): ViewerDoc[] {
  const { initiative, byPhase } = splitDocs(item);
  const fromDoc = (doc: DocEntry, group: string): ViewerDoc => ({
    key: doc.path,
    kind: doc.kind,
    formats: [...doc.formats],
    title: doc.title,
    ...(doc.phase === undefined ? {} : { phase: doc.phase }),
    group,
  });
  const ordered = [...new Set(phaseIds(item))].sort((left, right) => left - right);
  return [
    ...initiative.map((doc) => fromDoc(doc, "Initiative")),
    ...ordered.flatMap((phase) => (byPhase.get(phase) ?? []).map((doc) => fromDoc(doc, `Phase ${phase}`))),
    ...orderedReports(item).map((report) => ({
      key: `reports/${report.name}`,
      kind: "report" as const,
      formats: [...report.formats],
      title: report.name,
      ...(report.phase === undefined ? {} : { phase: report.phase }),
      group: "Reports",
    })),
  ];
}

/** Consecutive docs of the same group, for the viewer's navigation tree. */
export function groupViewerDocs(docs: readonly ViewerDoc[]): { group: string; entries: { doc: ViewerDoc; index: number }[] }[] {
  const groups: { group: string; entries: { doc: ViewerDoc; index: number }[] }[] = [];
  docs.forEach((doc, index) => {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.group === doc.group) last.entries.push({ doc, index });
    else groups.push({ group: doc.group, entries: [{ doc, index }] });
  });
  return groups;
}

/** Short label in a phase row: `phase-1.packet` -> `packet`, `00-investigation` -> `investigation`. */
export function docChipLabel(doc: Pick<DocEntry, "title" | "kind">): string {
  if (doc.kind === "task") return doc.title;
  const rest = doc.title.replace(/^phase-\d+[a-z]?(?:\.\d+)?[.-]?/, "").replace(/^\d{1,3}-/, "");
  return rest.length === 0 ? doc.title : rest;
}

/** Preferred format: markdown when it exists (rendered by the board), HTML otherwise. */
export function defaultDocFormat(doc: { formats: readonly DocFormat[] }): DocFormat {
  return doc.formats.includes("md") ? "md" : "html";
}

/** The authenticated endpoint for a file below the initiative folder (follows the active `?ref=`). */
export function docFileUrl(repoId: string, id: string, relative: string): string {
  const encoded = relative
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return repoApi(repoId, `/initiatives/${encodeURIComponent(id)}/docs/${encoded}`);
}

/**
 * Resolves `target` (a relative link in the document at `from`, a path below the initiative
 * folder) to a path inside the folder: from `phases/phase-1.packet`, `../ROADMAP.md` ->
 * `ROADMAP.md`. Undefined for absolute URLs, absolute paths, and anything that leaves the folder.
 */
export function resolveFromDoc(target: string, from: string): string | undefined {
  const clean = target.trim().split("#")[0]?.split("?")[0] ?? "";
  if (clean.length === 0 || clean.startsWith("/") || clean.includes("\\") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(clean)) {
    return undefined;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    return undefined;
  }
  const parts = from.split("/").slice(0, -1);
  for (const part of decoded.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.length === 0 ? undefined : parts.join("/");
}

/** Image `src` inside a document: committed `assets/` images and plain image files of the folder; the rest is blocked. */
export function docImageSrc(src: string, context: { repoId: string; id: string; from: string }): string {
  const target = resolveFromDoc(src, context.from);
  if (target === undefined) return "";
  if (ASSET_PATH.test(target)) return assetUrl(context.repoId, context.id, target);
  if (IMAGE.test(target)) return docFileUrl(context.repoId, context.id, target);
  return "";
}

export type DocLinkTarget =
  | { kind: "doc"; index: number; format: DocFormat; anchor?: string }
  | { kind: "external"; href: string }
  | { kind: "anchor"; id: string }
  | { kind: "none" };

function fragment(href: string): string | undefined {
  const hash = href.indexOf("#");
  if (hash === -1) return undefined;
  const raw = href.slice(hash + 1);
  if (raw.length === 0) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * What a link in the document at `from` does: another listed document (or report) opens in
 * the viewer, `#x` scrolls within it, other files in the folder open on the forge (https only),
 * `https:` / `mailto:` open outside.
 */
export function docLinkTarget(
  href: string,
  context: { from: string; docs: readonly ViewerDoc[]; forge: ForgeLinkConfig; sourceRef: string; folder: string },
): DocLinkTarget {
  const trimmed = href.trim();
  if (trimmed.startsWith("#")) {
    const id = fragment(trimmed);
    return id === undefined ? { kind: "none" } : { kind: "anchor", id };
  }
  if (/^https:\/\//i.test(trimmed) || /^mailto:/i.test(trimmed)) return { kind: "external", href: trimmed };
  const target = resolveFromDoc(trimmed, context.from);
  if (target === undefined) return { kind: "none" };
  const match = /^(.+)\.(md|html)$/.exec(target);
  if (match !== null) {
    const index = context.docs.findIndex((doc) => doc.key === match[1]);
    const format = match[2] as DocFormat;
    if (index !== -1 && context.docs[index]?.formats.includes(format)) {
      const anchor = fragment(trimmed);
      return anchor === undefined ? { kind: "doc", index, format } : { kind: "doc", index, format, anchor };
    }
  }
  const url = safeHttps(forgeFileUrl(context.forge, context.sourceRef, `${context.folder}/${target}`));
  return url === null ? { kind: "none" } : { kind: "external", href: url };
}

/** The document on the forge; null unless the configured template gives an https URL. */
export function forgeDocUrl(
  forge: ForgeLinkConfig,
  item: Pick<BoardItem, "sourceRef" | "path">,
  doc: Pick<ViewerDoc, "key">,
  format: DocFormat,
): string | null {
  const folder = item.path.slice(0, item.path.lastIndexOf("/"));
  return safeHttps(forgeFileUrl(forge, item.sourceRef, `${folder}/${doc.key}.${format}`));
}

function safeHttps(url: string): string | null {
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** Finds a heading for `#id` in rendered markdown (sanitized ids carry a `user-content-` prefix). */
export function findAnchor(root: ParentNode, id: string): Element | null {
  for (const candidate of [id, `user-content-${id}`, id.toLowerCase(), `user-content-${id.toLowerCase()}`]) {
    const found = root.querySelector(`[id="${CSS.escape(candidate)}"]`);
    if (found !== null) return found;
  }
  return null;
}
