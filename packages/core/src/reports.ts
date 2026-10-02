/** Most report entries kept per initiative, after grouping `.md` / `.html` twins. */
export const MAX_REPORTS_PER_INITIATIVE = 200;

/** Largest report file the board serves. */
export const MAX_REPORT_BYTES = 2 * 1024 * 1024;

export type ReportFormat = "md" | "html";

/**
 * One report under `<initiative folder>/reports/`. `name` is the path below `reports/`
 * without the extension (`phase-1.report`, `merge-review/plan`); `formats` lists the
 * files that exist (`name.md`, `name.html`).
 */
export interface ReportEntry {
  name: string;
  formats: ReportFormat[];
  /** Set when the file (or its sub-folder) name starts with `phase-<n>`. */
  phase?: number;
}

const PHASE_PREFIX = /^phase-(\d{1,4})(?![0-9])/;

/** `phase-2.report` -> 2, `phase-0-baseline/audit` -> 0, `final.report` -> undefined. */
export function reportPhase(name: string): number | undefined {
  const first = name.split("/")[0] ?? "";
  const match = PHASE_PREFIX.exec(first);
  return match === null ? undefined : Number(match[1]);
}

/**
 * Groups report file paths (relative to `reports/`, already filtered to `.md` and `.html`)
 * into entries, sorted by name, at most `MAX_REPORTS_PER_INITIATIVE`.
 */
export function groupReports(files: readonly string[]): ReportEntry[] {
  const byName = new Map<string, Set<ReportFormat>>();
  for (const file of files) {
    const match = /^(.+)\.(md|html)$/.exec(file);
    if (match === null) continue;
    const name = match[1] ?? "";
    const format = match[2] as ReportFormat;
    const formats = byName.get(name) ?? new Set<ReportFormat>();
    formats.add(format);
    byName.set(name, formats);
  }
  return [...byName.keys()]
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }))
    .slice(0, MAX_REPORTS_PER_INITIATIVE)
    .map((name) => {
      const set = byName.get(name) ?? new Set<ReportFormat>();
      const formats = (["md", "html"] as const).filter((format) => set.has(format));
      const phase = reportPhase(name);
      return phase === undefined ? { name, formats } : { name, formats, phase };
    });
}
