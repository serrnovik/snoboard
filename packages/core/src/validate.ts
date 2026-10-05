import type { Config } from "./config.js";
import { MAX_ISSUE_REFS, parseIssueRef } from "./issues.js";
import { linkProblem, MAX_LINKS } from "./links.js";
import { buildGraph, findCycles, type GraphItem } from "./graph.js";
import { iconProblem, isLabelColor, LABEL_COLORS } from "./icons.js";
import type { ParsedFile } from "./parse.js";

export type ValidationIssue = {
  path: string;
  field: string;
  message: string;
  severity: "error" | "warning";
};

const PHASE_TARGET = /^([a-z0-9_-]+-\d{3})#(0|[1-9]\d*)$/;
const STALE_EXEMPT = new Set(["parked", "dropped"]);

type InitiativeFile = Extract<ParsedFile, { kind: "initiative" }>;

function expectedId(config: Config, project: string, number: string): string {
  return config.idFormat.replaceAll("{project}", project).replaceAll("{number}", number);
}

function utcDay(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function dependencyFound(
  target: string,
  byId: ReadonlyMap<string, InitiativeFile>,
  knownIds: ReadonlySet<string> | undefined,
): boolean {
  if (knownIds?.has(target)) return true;
  const phase = PHASE_TARGET.exec(target);
  if (!phase?.[1] || !phase[2]) {
    return byId.has(target);
  }
  const owner = byId.get(phase[1]);
  if (!owner) return false;
  const phaseId = Number(phase[2]);
  return (owner.frontmatter.phases ?? []).some((item) => item.id === phaseId);
}

export function validate(
  files: readonly ParsedFile[],
  config: Config,
  opts?: { knownIds?: Set<string> },
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const initiatives = files.filter((file): file is InitiativeFile => file.kind === "initiative");
  const byId = new Map<string, InitiativeFile>();
  for (const file of initiatives) {
    if (!byId.has(file.frontmatter.id)) byId.set(file.frontmatter.id, file);
  }

  for (const file of files) {
    if (file.kind !== "error") continue;
    issues.push({
      path: file.path,
      field: "frontmatter",
      message: file.message,
      severity: "error",
    });
  }

  for (const file of initiatives) {
    const expected = expectedId(config, file.project, file.number);
    if (file.frontmatter.id !== expected) {
      issues.push({
        path: file.path,
        field: "id",
        message: `id "${file.frontmatter.id}" does not match "${expected}" from the path`,
        severity: "error",
      });
    }
  }

  const grouped = new Map<string, InitiativeFile[]>();
  for (const file of initiatives) {
    const group = grouped.get(file.frontmatter.id) ?? [];
    group.push(file);
    grouped.set(file.frontmatter.id, group);
  }
  for (const [id, group] of grouped) {
    if (group.length < 2) continue;
    const ordered = [...group].sort((left, right) => left.path.localeCompare(right.path));
    for (const file of ordered.slice(1)) {
      issues.push({
        path: file.path,
        field: "id",
        message: `duplicate id "${id}"`,
        severity: "error",
      });
    }
  }

  for (const file of initiatives) {
    for (const target of file.frontmatter.depends_on ?? []) {
      if (!dependencyFound(target, byId, opts?.knownIds)) {
        issues.push({
          path: file.path,
          field: "depends_on",
          message: `dependency "${target}" was not found`,
          severity: "error",
        });
      }
    }

    const phases = file.frontmatter.phases ?? [];
    const phaseIds = new Set(phases.map((phase) => phase.id));
    const seenPhaseIds = new Set<number>();
    for (const phase of phases) {
      if (seenPhaseIds.has(phase.id)) {
        issues.push({
          path: file.path,
          field: "phases",
          message: `duplicate phase id ${phase.id}`,
          severity: "error",
        });
      }
      seenPhaseIds.add(phase.id);
      for (const dependency of phase.depends_on ?? []) {
        if (!phaseIds.has(dependency)) {
          issues.push({
            path: file.path,
            field: "phases",
            message: `phase ${phase.id} depends on missing phase ${dependency}`,
            severity: "error",
          });
        }
      }
      if (
        config.doneStatuses.includes(file.frontmatter.status) &&
        (phase.status === "in-progress" || phase.status === "review")
      ) {
        issues.push({
          path: file.path,
          field: "phases",
          message: `phase ${phase.id} has status "${phase.status}" while the initiative is done`,
          severity: "error",
        });
      }
    }
  }

  for (const file of initiatives) {
    const links = file.frontmatter.links ?? [];
    if (links.length > MAX_LINKS) {
      issues.push({
        path: file.path,
        field: "links",
        message: `${links.length} links; at most ${MAX_LINKS} are allowed`,
        severity: "error",
      });
    }
    links.forEach((link, index) => {
      const problem = linkProblem(link);
      if (problem === undefined) return;
      issues.push({ path: file.path, field: "links", message: `link ${index + 1}: ${problem}`, severity: "error" });
    });
  }

  for (const file of initiatives) {
    const refCount = file.frontmatter.issues?.length ?? 0;
    if (refCount > MAX_ISSUE_REFS) {
      issues.push({
        path: file.path,
        field: "issues",
        message: `${refCount} issue refs; at most ${MAX_ISSUE_REFS} are allowed`,
        severity: "error",
      });
    }
    const seenIssueRefs = new Set<string>();
    for (const refText of file.frontmatter.issues ?? []) {
      const parsed = parseIssueRef(refText);
      if (!parsed) {
        issues.push({
          path: file.path,
          field: "issues",
          message: `invalid issue ref "${refText}"`,
          severity: "error",
        });
        continue;
      }
      if (seenIssueRefs.has(parsed.raw)) {
        issues.push({
          path: file.path,
          field: "issues",
          message: `duplicate issue ref "${parsed.raw}"`,
          severity: "warning",
        });
        continue;
      }
      seenIssueRefs.add(parsed.raw);
      if (!parsed.known) {
        issues.push({
          path: file.path,
          field: "issues",
          message: `unknown issue provider "${parsed.provider}"`,
          severity: "warning",
        });
      }
    }
  }
  for (const file of initiatives) {
    if (file.frontmatter.icon === undefined) continue;
    const problem = iconProblem(file.frontmatter.icon);
    if (problem === undefined) continue;
    issues.push({ path: file.path, field: "icon", message: problem, severity: "warning" });
  }
  issues.push(...configIconIssues(config));

  const graphItems: GraphItem[] = initiatives.map((file) => ({
    id: file.frontmatter.id,
    status: file.frontmatter.status,
    depends_on: [...(file.frontmatter.depends_on ?? [])],
    phases: file.frontmatter.phases,
  }));
  for (const cycle of findCycles(buildGraph(graphItems, config))) {
    const anchor = cycle[0] ?? "";
    const base = anchor.split("#")[0] ?? anchor;
    issues.push({
      path: byId.get(base)?.path ?? "",
      field: "depends_on",
      message: `dependency cycle: ${cycle.join(" -> ")}`,
      severity: "error",
    });
  }

  const today = new Date();
  const todayNumber = utcDay(today.getUTCFullYear(), today.getUTCMonth() + 1, today.getUTCDate());
  for (const file of initiatives) {
    const status = file.frontmatter.status;
    if (config.doneStatuses.includes(status) || STALE_EXEMPT.has(status)) continue;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(file.frontmatter.updated);
    if (!match?.[1] || !match[2] || !match[3]) continue;
    const age = todayNumber - utcDay(Number(match[1]), Number(match[2]), Number(match[3]));
    if (age > config.staleAfterDays) {
      issues.push({
        path: file.path,
        field: "updated",
        message: `updated ${file.frontmatter.updated} is older than ${config.staleAfterDays} days`,
        severity: "warning",
      });
    }
  }

  return issues;
}

/** Warnings for `projects` and `labels` display settings in `.snoboard.yml`. */
export function configIconIssues(config: Config): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const [project, display] of Object.entries(config.projects ?? {})) {
    if (display.icon === undefined) continue;
    const problem = iconProblem(display.icon);
    if (problem !== undefined) {
      issues.push({ path: ".snoboard.yml", field: `projects.${project}.icon`, message: problem, severity: "warning" });
    }
  }
  for (const [label, display] of Object.entries(config.labels ?? {})) {
    if (display.icon !== undefined) {
      const problem = iconProblem(display.icon, { emojiOnly: true });
      if (problem !== undefined) {
        issues.push({ path: ".snoboard.yml", field: `labels.${label}.icon`, message: problem, severity: "warning" });
      }
    }
    if (display.color !== undefined && !isLabelColor(display.color)) {
      issues.push({
        path: ".snoboard.yml",
        field: `labels.${label}.color`,
        message: `color must be one of: ${LABEL_COLORS.join(", ")}`,
        severity: "warning",
      });
    }
  }
  return issues;
}
