/** Most document entries kept per initiative (after grouping `.md` / `.html` twins), reports excluded. */
export const MAX_DOCS_PER_INITIATIVE = 300;

/** Deepest document path below the initiative folder: `phases/phase-1/T1.1-x.md` is 3 segments. */
export const MAX_DOC_DEPTH = 3;

/** Largest document file the board serves (same cap as reports). */
export const MAX_DOC_BYTES = 2 * 1024 * 1024;

export type DocFormat = "md" | "html";

/**
 * - `phase-doc`: a file in `phases/` (packets, prompts, README) or a top-level `phase-<n>...` file.
 * - `task`: a file in a per-phase folder, `phases/phase-<n>/T<n>.<m>-<slug>.md`.
 * - `initiative-doc`: any other file in the initiative folder (`ROADMAP.md`, `CONVENTIONS.md`, ...).
 * - `report`: a file below `reports/`; listed separately as `BoardItem.reports`.
 */
export type DocKind = "phase-doc" | "task" | "initiative-doc" | "report";

/**
 * One document of an initiative. `path` is relative to the initiative folder, without the
 * extension (`phases/phase-1.packet`, `ROADMAP`); `formats` lists the files that exist.
 */
export interface DocEntry {
  path: string;
  kind: Exclude<DocKind, "report">;
  formats: DocFormat[];
  /** Taken from the file name (no blob reads): `phase-1.packet`, `T1.2-schema`, `ROADMAP`. */
  title: string;
  /** Phase number from `phase-<n>`, `phase-<n>a`, `phase-<n>.<m>`, `phases/NN-...` or `phases/phase-<n>/...`. */
  phase?: number;
}

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const PHASE_PREFIX = /^phase-(\d{1,4})(?![0-9])/;
const NUMBER_PREFIX = /^(\d{1,3})-/;

/**
 * A document path relative to the initiative folder: `.md` / `.html`, 1 to `MAX_DOC_DEPTH`
 * plain ASCII segments, no dot segments, not below `reports/` (those are reports).
 */
export function isDocFile(relative: string): boolean {
  const parts = relative.split("/");
  if (parts.length < 1 || parts.length > MAX_DOC_DEPTH) return false;
  if (parts[0] === "reports" && parts.length > 1) return false;
  if (!parts.every((part) => SEGMENT.test(part) && !part.includes(".."))) return false;
  return /\.(md|html)$/.test(parts[parts.length - 1] ?? "");
}

function phaseOf(name: string, numberPrefix: boolean): number | undefined {
  const phase = PHASE_PREFIX.exec(name);
  if (phase !== null) return Number(phase[1]);
  if (!numberPrefix) return undefined;
  const number = NUMBER_PREFIX.exec(name);
  return number === null ? undefined : Number(number[1]);
}

/** Kind and phase of `path` (relative to the initiative folder, extension optional). */
export function classifyDoc(path: string): { kind: DocEntry["kind"]; phase?: number } {
  const parts = path.replace(/\.(md|html)$/, "").split("/");
  const base = parts[parts.length - 1] ?? "";
  if (parts[0] === "phases" && parts.length >= 2) {
    if (parts.length === 2) {
      const phase = phaseOf(base, true);
      return phase === undefined ? { kind: "phase-doc" } : { kind: "phase-doc", phase };
    }
    // `phases/phase-<n>/...` (or `phases/NN-.../...`): task files of that phase.
    const phase = phaseOf(parts[1] ?? "", true);
    return phase === undefined ? { kind: "phase-doc" } : { kind: "task", phase };
  }
  const phase = phaseOf(parts[0] ?? "", false) ?? (parts.length === 1 ? undefined : phaseOf(base, false));
  return phase === undefined ? { kind: "initiative-doc" } : { kind: "phase-doc", phase };
}

/**
 * Groups document paths (relative to the initiative folder, already filtered with
 * `isDocFile`) into entries, natural sort by path, at most `MAX_DOCS_PER_INITIATIVE`.
 * `initiativeFile` (usually `initiative.md`) is the initiative itself and is skipped.
 */
export function groupDocs(files: readonly string[], initiativeFile = "initiative.md"): DocEntry[] {
  const byPath = new Map<string, Set<DocFormat>>();
  for (const file of files) {
    if (file === initiativeFile || !isDocFile(file)) continue;
    const match = /^(.+)\.(md|html)$/.exec(file);
    if (match === null) continue;
    const path = match[1] ?? "";
    const formats = byPath.get(path) ?? new Set<DocFormat>();
    formats.add(match[2] as DocFormat);
    byPath.set(path, formats);
  }
  return [...byPath.keys()]
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }))
    .slice(0, MAX_DOCS_PER_INITIATIVE)
    .map((path) => {
      const set = byPath.get(path) ?? new Set<DocFormat>();
      const formats = (["md", "html"] as const).filter((format) => set.has(format));
      const { kind, phase } = classifyDoc(path);
      const title = path.slice(path.lastIndexOf("/") + 1);
      return phase === undefined ? { path, kind, formats, title } : { path, kind, formats, title, phase };
    });
}
