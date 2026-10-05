import { createHash } from "node:crypto";
import { isMap, isNode, isScalar, isSeq, parseDocument, YAMLMap as YAMLMapNode, YAMLSeq, type Document, type YAMLMap } from "yaml";
import { z } from "zod";
import { DEPENDENCY_ID, EditSchema, MAX_INITIATIVE_BODY_LENGTH, INITIATIVE_ID, PROJECT_NAME, SLUG_NAME, type Edit } from "./edit-schema.js";
import type { Config } from "./config.js";

const PLAIN_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const UPDATED_LINE = /^([ \t]*updated:[ \t]*)(['"]?)(\d{4}-\d{2}-\d{2})\2([ \t]*(?:#[^\r\n]*)?)(\r?)$/m;

const INITIATIVE_TEMPLATE = `---
id: {{id}}
title: {{titleYaml}}
status: {{status}}
priority: {{priority}}
updated: {{updated}}
---

# {{title}}

## Summary

## Goals

## Phases
`;

export { EditSchema, type Edit } from "./edit-schema.js";

export type ApplyEditResult = { text: string } | { error: string };

export type NewInitiativeInput = {
  project: string;
  slug: string;
  title: string;
  status: string;
  priority: string;
  depends_on?: readonly string[];
  /** Replaces the template body. Written after the generated frontmatter and a blank line. */
  body?: string;
};

type FieldEdit = Exclude<Edit, { kind: "createInitiative" | "setBody" | "addAttachment" }>;

type SplitFile = {
  bom: string;
  open: string;
  yaml: string;
  fence: string;
  body: string;
  newline: "\n" | "\r\n";
};

/** sha256 hex of the initiative body (everything after the closing frontmatter fence). */
export function bodyHash(text: string): string {
  const split = splitInitiative(text);
  const body = "error" in split ? text : split.body;
  return sha256(body);
}

export function applyEdit(text: string, edit: Edit, config: Config, today: string): ApplyEditResult {
  const parsed = EditSchema.safeParse(edit);
  if (!parsed.success) return { error: "invalid edit" };
  if (!z.iso.date().safeParse(today).success) return { error: "invalid date" };
  const value = parsed.data;
  if (value.kind === "createInitiative") {
    return { error: "createInitiative does not apply to an existing file" };
  }
  if (value.kind === "addAttachment") {
    return { error: "addAttachment does not change the initiative file" };
  }

  const split = splitInitiative(text);
  if ("error" in split) return split;
  const doc = parseDocument(split.yaml.replaceAll("\r\n", "\n"), { schema: "core" });
  if (doc.errors.length > 0 || !isMap(doc.contents)) return { error: "frontmatter did not parse" };
  const root = doc.contents;
  const id = readString(root, "id");
  if (isFailure(id)) return id;
  if (id !== value.id) return { error: "id mismatch" };

  if (value.kind === "setBody") {
    if (sha256(split.body) !== value.fromHash) return { error: "stale" };
    const yaml = replaceUpdated(split.yaml, today);
    if (yaml === null) return { error: "updated could not be replaced" };
    return {
      text: joinInitiative({ ...split, yaml, body: normalizeNewlines(value.to, split.newline) }),
    };
  }

  const failed = mutate(root, value, config);
  if (failed !== undefined) return failed;
  setString(root, "updated", today);
  return { text: joinInitiative({ ...split, yaml: serializeYaml(doc, split.newline) }) };
}

export function renderNewInitiative(
  input: NewInitiativeInput,
  number: number,
  config: Config,
  today: string,
): { path: string; text: string } {
  assertProject(input.project);
  assertSlug(input.slug);
  if (!Number.isSafeInteger(number) || number < 0 || number > 999) {
    throw new Error("Number must be an integer from 0 to 999.");
  }
  if (input.title.trim().length === 0) throw new Error("Title is empty.");
  if (/[\r\n]/.test(input.title)) throw new Error("Title cannot contain line breaks.");
  if (!z.iso.date().safeParse(today).success) throw new Error("Updated must be a YYYY-MM-DD date.");
  assertPlain("Status", input.status, config.statuses, "statuses");
  assertPlain("Priority", input.priority, config.priorities, "priorities");
  const dependsOn = input.depends_on ?? [];
  for (const dependency of dependsOn) {
    if (!DEPENDENCY_ID.test(dependency)) throw new Error(`depends_on entry "${dependency}" is invalid.`);
  }

  const padded = String(number).padStart(3, "0");
  const id = config.idFormat.replaceAll("{project}", input.project).replaceAll("{number}", padded);
  if (!INITIATIVE_ID.test(id)) throw new Error(`id "${id}" is not a valid initiative id.`);
  let text = renderTemplate(INITIATIVE_TEMPLATE, {
    id,
    title: input.title,
    titleYaml: yamlDoubleQuoted(input.title),
    status: input.status,
    priority: input.priority,
    updated: today,
  });
  if (dependsOn.length > 0) text = insertDependsOn(text, dependsOn);
  if (input.body !== undefined) text = replaceTemplateBody(text, input.body);
  return {
    path: [config.root, input.project, `${padded}-${input.slug}`, config.file].join("/"),
    text,
  };
}

export function summarizeEdit(edit: Edit): string {
  const value = EditSchema.parse(edit);
  switch (value.kind) {
    case "setStatus":
      return oneLine(`${value.id}: status ${value.from} -> ${value.to}`);
    case "setPriority":
      return oneLine(`${value.id}: priority ${value.from} -> ${value.to}`);
    case "setPhaseStatus":
      return oneLine(`${value.id}: phase ${value.phase} status ${value.from} -> ${value.to}`);
    case "setTitle":
      return oneLine(`${value.id}: title ${value.from} -> ${value.to}`);
    case "setIcon":
      return oneLine(`${value.id}: icon ${value.from === "" ? "(none)" : value.from} -> ${value.to === "" ? "(none)" : value.to}`);
    case "setLabels":
      return oneLine(`${value.id}: labels ${formatLabels(value.from)} -> ${formatLabels(value.to)}`);
    case "setBody":
      return oneLine(`${value.id}: body`);
    case "setIssues":
      return oneLine(`${value.id}: issues ${formatLabels(value.from)} -> ${formatLabels(value.to)}`);
    case "setLinks":
      return oneLine(`${value.id}: links ${countOf(value.from.length, "link")} -> ${countOf(value.to.length, "link")}`);
    case "addAttachment":
      return oneLine(`${value.id}: attach ${value.path} (${formatBytes(value.size)})`);
    case "createInitiative":
      return oneLine(`create ${value.project}/${value.slug}: ${value.title}`);
  }
}

function mutate(root: YAMLMap, edit: FieldEdit, config: Config): { error: string } | undefined {
  switch (edit.kind) {
    case "setStatus":
      return setScalarField(root, "status", edit.from, edit.to, config.statuses, "status not in config");
    case "setPriority":
      return setScalarField(root, "priority", edit.from, edit.to, config.priorities, "priority not in config");
    case "setTitle": {
      if (edit.to.trim().length === 0 || /[\r\n]/.test(edit.to)) return { error: "invalid title" };
      return setScalarField(root, "title", edit.from, edit.to);
    }
    case "setIcon": {
      const current = readString(root, "icon");
      if (isFailure(current)) return current;
      if ((current ?? "") !== edit.from) return { error: "stale" };
      if (edit.to === "") root.delete("icon");
      else setString(root, "icon", edit.to);
      return undefined;
    }
    case "setLabels": {
      const current = readLabels(root);
      if (isFailure(current)) return current;
      if (!sameStrings(current, edit.from)) return { error: "stale" };
      if (edit.to.some((label) => label.length === 0 || /[\r\n]/.test(label))) return { error: "invalid label" };
      replaceLabels(root, edit.to);
      return undefined;
    }
    case "setIssues": {
      const current = readStringList(root, "issues");
      if (isFailure(current)) return current;
      if (!sameStrings(current, edit.from)) return { error: "stale" };
      if (new Set(edit.to).size !== edit.to.length) return { error: "duplicate issue ref" };
      replaceList(root, "issues", edit.to.length === 0 ? undefined : listNode(edit.to));
      return undefined;
    }
    case "setLinks": {
      const current = readLinks(root);
      if (isFailure(current)) return current;
      if (!sameLinks(current, edit.from)) return { error: "stale" };
      const seq = new YAMLSeq<YAMLMap>();
      for (const link of edit.to) {
        const map = new YAMLMapNode<string, string>();
        map.set("title", link.title);
        map.set("url", link.url);
        seq.add(map);
      }
      replaceList(root, "links", edit.to.length === 0 ? undefined : seq);
      return undefined;
    }
    case "setPhaseStatus": {
      const phase = phaseMap(root, edit.phase);
      if (phase === undefined) return { error: "unknown phase" };
      return setScalarField(phase, "status", edit.from, edit.to, config.statuses, "status not in config");
    }
  }
}

function setScalarField(
  map: YAMLMap,
  key: string,
  from: string,
  to: string,
  allowed?: readonly string[],
  rejected?: string,
): { error: string } | undefined {
  if (allowed !== undefined && !allowed.includes(to)) return { error: rejected ?? "value not in config" };
  const current = readString(map, key);
  if (isFailure(current)) return current;
  if ((current ?? "") !== from) return { error: "stale" };
  setString(map, key, to);
  return undefined;
}

function phaseMap(map: YAMLMap, phaseId: number): YAMLMap | undefined {
  const phases = map.get("phases", true);
  if (!isSeq(phases)) return undefined;
  for (const item of phases.items) {
    if (!isMap(item)) continue;
    const id = item.get("id");
    if (id === phaseId) return item;
  }
  return undefined;
}

function replaceLabels(map: YAMLMap, labels: readonly string[]): void {
  const pair = map.items.find((item) => isScalar(item.key) && item.key.value === "labels");
  const saved = pair !== undefined && isNode(pair.value) ? pair.value.commentBefore : undefined;
  const seq = new YAMLSeq<string>();
  for (const label of labels) seq.add(label);
  if (pair === undefined) {
    map.set("labels", seq);
    return;
  }
  pair.value = seq;
  if (saved === undefined || saved === null || !isScalar(pair.key) || pair.key.comment != null) return;
  pair.key.comment = saved;
}
function listNode(values: readonly string[]): YAMLSeq<string> {
  const seq = new YAMLSeq<string>();
  for (const value of values) seq.add(value);
  return seq;
}

/** Replace (or, with `undefined`, delete) a list field, keeping a comment that sat above the old value. */
function replaceList(map: YAMLMap, key: string, value: YAMLSeq | undefined): void {
  if (value === undefined) {
    map.delete(key);
    return;
  }
  const pair = map.items.find((item) => isScalar(item.key) && item.key.value === key);
  if (pair === undefined) {
    map.set(key, value);
    return;
  }
  const saved = isNode(pair.value) ? pair.value.commentBefore : undefined;
  pair.value = value;
  if (saved === undefined || saved === null || !isScalar(pair.key) || pair.key.comment != null) return;
  pair.key.comment = saved;
}

function readStringList(map: YAMLMap, key: string): string[] | { error: string } {
  if (!map.has(key)) return [];
  const node = map.get(key, true);
  const value = isSeq(node) ? node.toJSON() : node;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return { error: `${key} are not a list` };
  }
  return value;
}

function readLinks(map: YAMLMap): { title: string; url: string }[] | { error: string } {
  if (!map.has("links")) return [];
  const node = map.get("links", true);
  const value: unknown = isSeq(node) ? node.toJSON() : node;
  if (!Array.isArray(value)) return { error: "links are not a list" };
  const links: { title: string; url: string }[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return { error: "links are not a list" };
    const record = entry as Record<string, unknown>;
    if (typeof record.title !== "string" || typeof record.url !== "string") return { error: "links are not a list" };
    links.push({ title: record.title, url: record.url });
  }
  return links;
}

function sameLinks(
  left: readonly { title: string; url: string }[],
  right: readonly { title: string; url: string }[],
): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => item.title === right[index]?.title && item.url === right[index]?.url)
  );
}

function readLabels(map: YAMLMap): string[] | { error: string } {
  if (!map.has("labels")) return [];
  const node = map.get("labels", true);
  const value = isSeq(node) ? node.toJSON() : node;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return { error: "labels are not a list" };
  }
  return value;
}

function readString(map: YAMLMap, key: string): string | undefined | { error: string } {
  if (!map.has(key)) return undefined;
  const node = map.get(key, true);
  if (!isScalar(node) || typeof node.value !== "string") return { error: `${key} is not text` };
  return node.value;
}

function setString(map: YAMLMap, key: string, value: string): void {
  const node = map.get(key, true);
  if (isScalar(node)) {
    node.value = value;
    return;
  }
  map.set(key, value);
}

function isFailure(value: unknown): value is { error: string } {
  return typeof value === "object" && value !== null && "error" in value;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function serializeYaml(doc: Document, newline: "\n" | "\r\n"): string {
  let yaml = doc.toString({ lineWidth: 0 });
  if (yaml.endsWith("\n")) yaml = yaml.slice(0, -1);
  if (newline === "\r\n") yaml = yaml.replaceAll("\n", "\r\n");
  return yaml;
}

function replaceUpdated(yaml: string, today: string): string | null {
  const match = UPDATED_LINE.exec(yaml);
  if (match === null) return null;
  const prefix = match[1] ?? "";
  const quote = match[2] ?? "";
  const suffix = match[4] ?? "";
  const cr = match[5] ?? "";
  const start = match.index;
  const end = start + match[0].length;
  return `${yaml.slice(0, start)}${prefix}${quote}${today}${quote}${suffix}${cr}${yaml.slice(end)}`;
}

function splitInitiative(text: string): SplitFile | { error: string } {
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const source = bom.length > 0 ? text.slice(1) : text;
  const match = /^(---)(\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))([\s\S]*)$/.exec(source);
  if (match === null) {
    if (!source.startsWith("---")) return { error: "frontmatter missing" };
    return { error: "frontmatter was not closed" };
  }
  const newline = match[2] === "\r\n" ? "\r\n" : "\n";
  return {
    bom,
    open: `---${match[2] ?? "\n"}`,
    yaml: match[3] ?? "",
    fence: match[4] ?? "",
    body: match[5] ?? "",
    newline,
  };
}

function joinInitiative(split: SplitFile): string {
  return `${split.bom}${split.open}${split.yaml}${split.fence}${split.body}`;
}

function normalizeNewlines(body: string, newline: "\n" | "\r\n"): string {
  const lf = body.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  return newline === "\r\n" ? lf.replaceAll("\n", "\r\n") : lf;
}

function sha256(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

function renderTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replaceAll(/\{\{([A-Za-z]+)\}\}/g, (match, key: string) => values[key] ?? match);
}

function insertDependsOn(text: string, dependsOn: readonly string[]): string {
  const fence = "\n---\n";
  const at = text.indexOf(fence);
  if (at === -1) throw new Error("Initiative template is missing a closing frontmatter fence.");
  const block = dependsOn.map((id) => `  - ${id}`).join("\n");
  return `${text.slice(0, at)}\ndepends_on:\n${block}${text.slice(at)}`;
}

function replaceTemplateBody(text: string, body: string): string {
  if (body.length > MAX_INITIATIVE_BODY_LENGTH) throw new Error("Body is too long.");
  const fence = "\n---\n";
  const at = text.indexOf(fence);
  if (at === -1) throw new Error("Initiative template is missing a closing frontmatter fence.");
  // Exactly what the user typed, with LF line endings and a final newline.
  const lf = normalizeNewlines(body, "\n");
  const ending = lf.length === 0 || lf.endsWith("\n") ? "" : "\n";
  return `${text.slice(0, at + fence.length)}\n${lf}${ending}`;
}

function yamlDoubleQuoted(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function assertProject(project: string): void {
  if (!PROJECT_NAME.test(project)) {
    throw new Error(
      `Project "${project}" must start with a letter or digit and use only lowercase letters, digits, "_" or "-".`,
    );
  }
}

function assertSlug(slug: string): void {
  if (!SLUG_NAME.test(slug)) {
    throw new Error(`Slug "${slug}" must use lowercase letters, digits, and single hyphens.`);
  }
}

function assertPlain(label: string, value: string, allowed: readonly string[], listName: string): void {
  if (!allowed.includes(value)) throw new Error(`${label} "${value}" is not one of: ${allowed.join(", ")}.`);
  if (!PLAIN_TOKEN.test(value)) throw new Error(`${label} "${value}" is not a safe ${listName} token.`);
}

function formatLabels(labels: readonly string[]): string {
  return labels.length === 0 ? "(none)" : labels.join(", ");
}

function countOf(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function oneLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}