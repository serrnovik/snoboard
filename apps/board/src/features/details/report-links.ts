import { ASSET_PATH, type BoardItem } from "snoboard/browser";
import { assetUrl } from "@/features/attachments/images";
import { repoApi } from "@/lib/routes";
import { forgeFileUrl, type ForgeLinkConfig } from "./links.js";

export type ReportFormat = "md" | "html";
export type Report = NonNullable<BoardItem["reports"]>[number];

const REPORT_IMAGE = /^reports\/(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,127}\/)?[A-Za-z0-9_][A-Za-z0-9._-]{0,127}\.(?:png|jpe?g|webp|gif)$/;

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

/** Preferred format: markdown when it exists (rendered by the board), HTML otherwise. */
export function defaultFormat(report: Report): ReportFormat {
  return report.formats.includes("md") ? "md" : "html";
}

/** The authenticated endpoint for a file below the initiative's `reports/` folder. */
export function reportFileUrl(repoId: string, id: string, relative: string): string {
  const encoded = relative
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return repoApi(repoId, `/initiatives/${encodeURIComponent(id)}/reports/${encoded}`);
}

/**
 * Resolves `target` (a relative link in report `name`) to a path inside the initiative
 * folder, e.g. `../assets/x.png` -> `assets/x.png`, `./img.png` -> `reports/img.png`.
 * Undefined for absolute URLs, absolute paths, and anything that leaves the folder.
 */
export function resolveInFolder(target: string, name: string): string | undefined {
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
  const parts = `reports/${name}`.split("/").slice(0, -1);
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

/** Image `src` inside a report: committed `assets/` images and images below `reports/`; everything else is blocked. */
export function reportImageSrc(src: string, context: { repoId: string; id: string; name: string }): string {
  const target = resolveInFolder(src, context.name);
  if (target === undefined) return "";
  if (ASSET_PATH.test(target)) return assetUrl(context.repoId, context.id, target);
  if (REPORT_IMAGE.test(target)) return reportFileUrl(context.repoId, context.id, target.slice("reports/".length));
  return "";
}

export type ReportLinkTarget =
  | { kind: "report"; index: number; format: ReportFormat }
  | { kind: "external"; href: string }
  | { kind: "anchor"; href: string }
  | { kind: "none" };

/**
 * What a link in report `name` does: another listed report opens in the dialog, other
 * files in the folder open on the forge (https only), `https:` / `mailto:` open outside.
 */
export function reportLinkTarget(
  href: string,
  context: { name: string; reports: readonly Report[]; forge: ForgeLinkConfig; sourceRef: string; folder: string },
): ReportLinkTarget {
  const trimmed = href.trim();
  if (trimmed.startsWith("#")) return { kind: "anchor", href: trimmed };
  if (/^https:\/\//i.test(trimmed) || /^mailto:/i.test(trimmed)) return { kind: "external", href: trimmed };
  const target = resolveInFolder(trimmed, context.name);
  if (target === undefined) return { kind: "none" };
  const match = /^reports\/(.+)\.(md|html)$/.exec(target);
  if (match !== null) {
    const index = context.reports.findIndex((report) => report.name === match[1]);
    const format = match[2] as ReportFormat;
    if (index !== -1 && context.reports[index]?.formats.includes(format)) return { kind: "report", index, format };
  }
  const url = safeHttps(forgeFileUrl(context.forge, context.sourceRef, `${context.folder}/${target}`));
  return url === null ? { kind: "none" } : { kind: "external", href: url };
}

/** The report file on the forge; null unless the configured template gives an https URL. */
export function forgeReportUrl(
  forge: ForgeLinkConfig,
  item: Pick<BoardItem, "sourceRef" | "path">,
  report: Report,
  format: ReportFormat,
): string | null {
  const folder = item.path.slice(0, item.path.lastIndexOf("/"));
  return safeHttps(forgeFileUrl(forge, item.sourceRef, `${folder}/reports/${report.name}.${format}`));
}

function safeHttps(url: string): string | null {
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}
