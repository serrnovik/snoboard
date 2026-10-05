import {
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  type Document,
  type Node,
  type Scalar,
  type YAMLMap,
  type YAMLSeq,
} from "yaml";
import type { Config } from "./config.js";

export type FixChange = {
  path: string;
  field: string;
  from: string;
  to: string;
};

export type FixReport = {
  path: string;
  field: string;
  message: string;
};

export type FixEvent = FixChange | FixReport;

export type FixTextResult = {
  text: string;
  changed: boolean;
  events: FixEvent[];
};

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

type LocalEvent =
  | { kind: "change"; field: string; from: string; to: string }
  | { kind: "report"; field: string; message: string };

function isChange(event: FixEvent): event is FixChange {
  return "to" in event;
}

function show(value: unknown): string {
  if (value === undefined) return "(missing)";
  return JSON.stringify(value);
}

function change(field: string, from: string, to: string): LocalEvent {
  return { kind: "change", field, from, to };
}

function report(field: string, message: string): LocalEvent {
  return { kind: "report", field, message };
}

function foldToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function matchConfig(raw: string, allowed: readonly string[]): string | undefined {
  if (allowed.includes(raw)) return raw;
  const folded = foldToken(raw);
  const matches = allowed.filter((item) => foldToken(item) === folded);
  if (matches.length === 0) return undefined;
  return matches.find((item) => item === folded) ?? matches[0];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function expectedId(config: Config, project: string, number: string): string {
  return config.idFormat.replaceAll("{project}", project).replaceAll("{number}", number);
}

function differsOnlyByCaseOrPadding(
  current: string,
  project: string,
  number: string,
  idFormat: string,
): boolean {
  const numeric = String(Number(number));
  if (!/^\d+$/.test(numeric)) return false;
  let pattern = "^";
  for (const part of idFormat.split(/(\{project\}|\{number\})/)) {
    if (part === "{project}") pattern += escapeRegExp(project);
    else if (part === "{number}") pattern += `0*${numeric}`;
    else pattern += escapeRegExp(part);
  }
  pattern += "$";
  return new RegExp(pattern, "i").test(current);
}

function canonicalDate(value: string): string | undefined {
  const match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(value.trim());
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  const paddedMonth = String(month).padStart(2, "0");
  const paddedDay = String(day).padStart(2, "0");
  return `${String(year).padStart(4, "0")}-${paddedMonth}-${paddedDay}`;
}

function locateInitiative(
  filePath: string,
  config: Config,
): { project: string; number: string } | undefined {
  const parts = filePath
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .split("/")
    .filter((part) => part.length > 0 && part !== ".");
  const rootParts = config.root
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .split("/")
    .filter((part) => part.length > 0 && part !== ".");
  if (parts.length !== rootParts.length + 3) return undefined;
  if (rootParts.some((part, index) => parts[index] !== part)) return undefined;
  const project = parts[rootParts.length];
  const folder = parts[rootParts.length + 1];
  const file = parts[rootParts.length + 2];
  if (file !== config.file || project === undefined || folder === undefined) return undefined;
  const match = /^(\d{3})-.+$/.exec(folder);
  if (!match?.[1]) return undefined;
  return { project, number: match[1] };
}

function stable(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortValue(item));
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortValue(record[key]);
    }
    return sorted;
  }
  return value;
}

function scalarString(node: Scalar): string | undefined {
  return typeof node.value === "string" ? node.value : undefined;
}

function normalizeEnumScalar(
  node: Scalar,
  allowed: readonly string[],
  field: string,
  events: LocalEvent[],
): void {
  const raw = scalarString(node);
  if (raw === undefined) {
    events.push(report(field, `unknown value ${show(node.value)}`));
    return;
  }
  const next = matchConfig(raw, allowed);
  if (next === undefined) {
    events.push(report(field, `unknown value ${show(raw)}`));
    return;
  }
  if (next === raw) return;
  events.push(change(field, show(raw), show(next)));
  node.value = next;
}

function fixId(
  map: YAMLMap,
  project: string,
  number: string,
  config: Config,
  events: LocalEvent[],
): string | undefined {
  const node = map.get("id", true);
  if (!isScalar(node)) {
    events.push(report("id", `unknown value ${show(node)}`));
    return undefined;
  }
  const raw = scalarString(node);
  if (raw === undefined) {
    events.push(report("id", `unknown value ${show(node.value)}`));
    return undefined;
  }
  const expected = expectedId(config, project, number);
  if (raw === expected) return raw;
  if (!differsOnlyByCaseOrPadding(raw, project, number, config.idFormat)) return raw;
  events.push(change("id", show(raw), show(expected)));
  node.value = expected;
  return expected;
}

function fixUpdated(map: YAMLMap, events: LocalEvent[]): void {
  if (!map.has("updated")) return;
  const node = map.get("updated", true);
  if (!isScalar(node)) {
    events.push(report("updated", `unknown value ${show(node)}`));
    return;
  }
  const raw = scalarString(node);
  if (raw === undefined) {
    events.push(report("updated", `unknown value ${show(node.value)}`));
    return;
  }
  const next = canonicalDate(raw);
  if (next === undefined) {
    events.push(report("updated", `unknown value ${show(raw)}`));
    return;
  }
  if (next === raw) return;
  events.push(change("updated", show(raw), show(next)));
  node.value = next;
}

function dependencyHead(value: string): string {
  const hash = value.indexOf("#");
  return hash === -1 ? value : value.slice(0, hash);
}

function isSelfReference(
  value: string,
  project: string,
  number: string,
  config: Config,
  ownIds: ReadonlySet<string>,
): boolean {
  const head = dependencyHead(value);
  if (ownIds.has(head)) return true;
  return differsOnlyByCaseOrPadding(head, project, number, config.idFormat);
}

function fixDependsOn(
  doc: Document,
  map: YAMLMap,
  project: string,
  number: string,
  config: Config,
  ownIds: ReadonlySet<string>,
  events: LocalEvent[],
): void {
  if (!map.has("depends_on")) return;
  const node = fieldNode(map, "depends_on");
  if (isScalar(node)) {
    const raw = scalarString(node);
    if (raw === undefined) {
      events.push(report("depends_on", `unknown value ${show(node.value)}`));
      return;
    }
    const kept = isSelfReference(raw, project, number, config, ownIds) ? [] : [raw];
    map.set("depends_on", doc.createNode(kept));
    events.push(change("depends_on", show(raw), show(kept)));
    return;
  }
  if (!isSeq<Node>(node)) {
    events.push(report("depends_on", `unknown value ${show(node)}`));
    return;
  }
  const original = node.toJSON();
  const seen = new Set<string>();
  const kept: Node[] = [];
  for (const item of node.items) {
    if (isScalar(item) && typeof item.value === "string") {
      if (isSelfReference(item.value, project, number, config, ownIds)) continue;
      if (seen.has(item.value)) continue;
      seen.add(item.value);
    }
    kept.push(item);
  }
  if (kept.length === node.items.length) return;
  node.items = kept;
  events.push(change("depends_on", show(original), show(node.toJSON())));
}

function fieldNode(map: YAMLMap, key: string): unknown {
  for (const pair of map.items) {
    if (isScalar(pair.key) && pair.key.value === key) return pair.value;
  }
  return undefined;
}

function fixPhaseStatuses(phases: YAMLSeq<Node>, allowed: readonly string[], events: LocalEvent[]): void {
  phases.items.forEach((item, index) => {
    if (!isMap(item) || !item.has("status")) return;
    const status = item.get("status", true);
    if (!isScalar(status)) {
      events.push(report(`phases[${index}].status`, `unknown value ${show(status)}`));
      return;
    }
    normalizeEnumScalar(status, allowed, `phases[${index}].status`, events);
  });
}

/** Phase ids start at 0 or 1 (both are common); negatives are invalid. */
function phaseInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function idIsMissing(item: YAMLMap): boolean {
  if (!item.has("id")) return true;
  const node = item.get("id", true);
  if (node === null || node === undefined) return true;
  if (!isScalar(node)) return false;
  return node.value === null || node.value === undefined || node.value === "";
}

function phaseId(item: YAMLMap): number | undefined {
  const node = item.get("id", true);
  if (!isScalar(node)) return undefined;
  return phaseInt(node.value);
}

function fieldTargetsRemovedPhase(field: string, removed: ReadonlySet<number>): boolean {
  const match = /^phases\[(\d+)\]\./.exec(field);
  return match?.[1] !== undefined && removed.has(Number(match[1]));
}

function dedupePhases(phases: YAMLSeq<Node>, events: LocalEvent[]): void {
  const seen = new Set<string>();
  const kept: Node[] = [];
  const removed = new Set<number>();
  const removals: LocalEvent[] = [];
  phases.items.forEach((item, index) => {
    if (!isMap(item)) {
      kept.push(item);
      return;
    }
    const key = stable(item.toJSON());
    if (seen.has(key)) {
      removed.add(index);
      removals.push(change(`phases[${index}]`, show(item.toJSON()), "(removed duplicate)"));
      return;
    }
    seen.add(key);
    kept.push(item);
  });
  if (removed.size === 0) return;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event !== undefined && fieldTargetsRemovedPhase(event.field, removed)) {
      events.splice(index, 1);
    }
  }
  phases.items = kept;
  events.push(...removals);
}

function assignMissingPhaseIds(doc: Document, phases: YAMLSeq<Node>, events: LocalEvent[]): void {
  let max = 0;
  for (const item of phases.items) {
    if (!isMap(item)) continue;
    const id = phaseId(item);
    if (id !== undefined && id > max) max = id;
  }
  let next = max + 1;
  phases.items.forEach((item, index) => {
    if (!isMap(item) || !idIsMissing(item)) return;
    if (item.has("id")) item.delete("id");
    item.items.unshift(doc.createPair("id", next));
    events.push(change(`phases[${index}].id`, "(missing)", show(next)));
    next += 1;
  });
}

function applyFixes(
  doc: Document,
  map: YAMLMap,
  project: string,
  number: string,
  config: Config,
): LocalEvent[] {
  const events: LocalEvent[] = [];

  if (map.has("status")) {
    const status = map.get("status", true);
    if (isScalar(status)) normalizeEnumScalar(status, config.statuses, "status", events);
    else events.push(report("status", `unknown value ${show(status)}`));
  }
  if (map.has("priority")) {
    const priority = map.get("priority", true);
    if (isScalar(priority)) normalizeEnumScalar(priority, config.priorities, "priority", events);
    else events.push(report("priority", `unknown value ${show(priority)}`));
  }

  const phases = map.has("phases") ? fieldNode(map, "phases") : undefined;
  if (map.has("phases")) {
    if (isSeq<Node>(phases)) fixPhaseStatuses(phases, config.statuses, events);
    else events.push(report("phases", `unknown value ${show(phases)}`));
  }

  const originalNode = map.get("id", true);
  const originalId =
    isScalar(originalNode) && typeof originalNode.value === "string" ? originalNode.value : undefined;
  const resolvedId = fixId(map, project, number, config, events);
  const ownIds = new Set<string>();
  if (originalId !== undefined && originalId.length > 0) ownIds.add(originalId);
  if (resolvedId !== undefined && resolvedId.length > 0) ownIds.add(resolvedId);

  fixUpdated(map, events);
  fixDependsOn(doc, map, project, number, config, ownIds, events);

  if (isSeq<Node>(phases)) {
    dedupePhases(phases, events);
    assignMissingPhaseIds(doc, phases, events);
  }

  return events;
}

function lineEnding(text: string): "\r\n" | "\n" {
  return text.startsWith("---\r\n") ? "\r\n" : "\n";
}

function rebuild(yamlBody: string, ending: "\r\n" | "\n", markdown: string): string {
  let yamlOut = yamlBody.replaceAll("\r\n", "\n");
  if (!yamlOut.endsWith("\n")) yamlOut += "\n";
  if (ending === "\r\n") yamlOut = yamlOut.replaceAll("\n", "\r\n");
  return `---${ending}${yamlOut}---${ending}${markdown}`;
}

function toPublic(filePath: string, event: LocalEvent): FixEvent {
  if (event.kind === "change") {
    return { path: filePath, field: event.field, from: event.from, to: event.to };
  }
  return { path: filePath, field: event.field, message: event.message };
}

export function fixInitiativeText(filePath: string, text: string, config: Config): FixTextResult {
  const located = locateInitiative(filePath, config);
  if (!located) return { text, changed: false, events: [] };

  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const source = bom.length > 0 ? text.slice(1) : text;
  if (!source.startsWith("---")) return { text, changed: false, events: [] };

  const matched = FRONTMATTER.exec(source);
  if (!matched) {
    if (/^id\s*:/m.test(source)) {
      return {
        text,
        changed: false,
        events: [
          {
            path: filePath,
            field: "frontmatter",
            message: "Initiative frontmatter was not closed",
          },
        ],
      };
    }
    return { text, changed: false, events: [] };
  }

  const yamlText = matched[1] ?? "";
  const markdown = matched[2] ?? "";
  let doc: Document;
  try {
    doc = parseDocument(yamlText, { schema: "core" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/^id\s*:/m.test(yamlText)) {
      return {
        text,
        changed: false,
        events: [{ path: filePath, field: "frontmatter", message }],
      };
    }
    return { text, changed: false, events: [] };
  }

  if (doc.errors.length > 0) {
    if (/^id\s*:/m.test(yamlText)) {
      return {
        text,
        changed: false,
        events: [
          {
            path: filePath,
            field: "frontmatter",
            message: doc.errors[0]?.message ?? "Invalid frontmatter",
          },
        ],
      };
    }
    return { text, changed: false, events: [] };
  }

  const map = isMap(doc.contents) ? doc.contents : undefined;
  const idNode = map?.get("id", true);
  if (!map || !isScalar(idNode) || idNode.value === null || idNode.value === undefined) {
    return { text, changed: false, events: [] };
  }

  const local = applyFixes(doc, map, located.project, located.number, config);
  const events = local.map((event) => toPublic(filePath, event));
  if (!local.some((event) => event.kind === "change")) return { text, changed: false, events };

  const next = bom + rebuild(doc.toString({ lineWidth: 0 }), lineEnding(source), markdown);
  if (next === text) {
    return {
      text,
      changed: false,
      events: events.filter((event) => !isChange(event)),
    };
  }
  return { text: next, changed: true, events };
}

export function formatFixEvent(event: FixEvent): string {
  if (isChange(event)) {
    return `${event.path}: ${event.field}: ${event.from} -> ${event.to}\n`;
  }
  return `${event.path}: ${event.field}: ${event.message}\n`;
}
