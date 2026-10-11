import type { Edit } from "./edit-schema.js";

// No Node imports here: the browser bundle (snoboard/browser) uses these helpers.

type DocEdit = Extract<Edit, { kind: "setDoc" | "createDoc" }>;

function isDocEdit(edit: Edit): edit is DocEdit {
  return edit.kind === "setDoc" || edit.kind === "createDoc";
}

/**
 * What an edit changes, as a stable string. Two edits with the same key replace each other in a
 * basket (a document edited twice, a status moved twice). New initiatives and images never merge
 * with other edits, but still have a key so baskets can be merged across devices.
 */
export function editKey(edit: Edit): string {
  switch (edit.kind) {
    case "createInitiative":
      return `create:${edit.project}/${edit.slug}`;
    case "addAttachment":
      return `attach:${edit.id}:${edit.path}`;
    case "setDoc":
    case "createDoc":
      return `doc:${edit.id}:${edit.path}`;
    case "setPhaseStatus":
      return `setPhaseStatus:${edit.id}:${edit.phase}`;
    default:
      return `${edit.kind}:${edit.id}`;
  }
}

/** Whether `right` replaces `left` in a basket. New initiatives and images never do. */
export function sameEditTarget(left: Edit, right: Edit): boolean {
  if (left.kind === "createInitiative" || right.kind === "createInitiative") return false;
  if (left.kind === "addAttachment" || right.kind === "addAttachment") return false;
  return editKey(left) === editKey(right);
}

/** `next` with the value the person saw first (`from` / `fromHash` of the queued edit). */
export function withFirstFrom(existing: Edit, next: Edit): Edit {
  switch (existing.kind) {
    case "setBody":
      return next.kind === "setBody" ? { ...next, fromHash: existing.fromHash } : next;
    case "setDoc":
      return next.kind === "setDoc" ? { ...next, fromHash: existing.fromHash } : next;
    case "createDoc":
      // A document created in this basket stays a createDoc when it is edited again.
      return isDocEdit(next) ? { kind: "createDoc", id: existing.id, path: existing.path, to: next.to } : next;
    case "setLabels":
      return next.kind === "setLabels" ? { ...next, from: existing.from } : next;
    case "setIssues":
      return next.kind === "setIssues" ? { ...next, from: existing.from } : next;
    case "setLinks":
      return next.kind === "setLinks" ? { ...next, from: existing.from } : next;
    case "setStatus":
      return next.kind === "setStatus" ? { ...next, from: existing.from } : next;
    case "setPriority":
      return next.kind === "setPriority" ? { ...next, from: existing.from } : next;
    case "setTitle":
      return next.kind === "setTitle" ? { ...next, from: existing.from } : next;
    case "setIcon":
      return next.kind === "setIcon" ? { ...next, from: existing.from } : next;
    case "setPhaseStatus":
      return next.kind === "setPhaseStatus" ? { ...next, from: existing.from } : next;
    case "createInitiative":
    case "addAttachment":
      return next;
  }
}

/** An edit that would change nothing (`from` equals `to`). Text edits are never no-ops. */
export function isNoOpEdit(edit: Edit): boolean {
  switch (edit.kind) {
    case "setBody":
    case "setDoc":
    case "createDoc":
    case "createInitiative":
    case "addAttachment":
      return false;
    case "setLabels":
    case "setIssues":
      return sameStrings(edit.from, edit.to);
    case "setLinks":
      return (
        edit.from.length === edit.to.length &&
        edit.from.every((link, index) => link.title === edit.to[index]?.title && link.url === edit.to[index]?.url)
      );
    case "setStatus":
    case "setPriority":
    case "setTitle":
    case "setIcon":
    case "setPhaseStatus":
      return edit.from === edit.to;
  }
}

/**
 * Queue `next` in a basket: replaces a queued edit with the same target (keeping the value the
 * person saw first) or appends it. An edit that ends up changing nothing leaves the basket.
 */
export function mergeIntoBasket(edits: readonly Edit[], next: Edit): Edit[] {
  if (next.kind === "createInitiative") return [...edits, next];
  if (next.kind === "addAttachment") {
    const same = edits.some((edit) => edit.kind === "addAttachment" && edit.id === next.id && edit.path === next.path);
    return same ? [...edits] : [...edits, next];
  }
  const index = edits.findIndex((edit) => sameEditTarget(edit, next));
  if (index === -1) {
    if (isNoOpEdit(next)) return [...edits];
    return [...edits, next];
  }
  const merged = withFirstFrom(edits[index]!, next);
  if (isNoOpEdit(merged)) return edits.filter((_, entryIndex) => entryIndex !== index);
  const copy = [...edits];
  copy[index] = merged;
  return copy;
}

export type BasketChange = {
  /** Keys of edits added or changed since the version the writer last synced. */
  changedKeys: readonly string[];
  /** Keys of edits removed since that version. */
  removedKeys: readonly string[];
};

/** What changed between the last synced basket and the local one, by edit key. */
export function diffBaskets(base: readonly Edit[], local: readonly Edit[]): BasketChange {
  const before = new Map(base.map((edit) => [editKey(edit), JSON.stringify(edit)]));
  const after = new Map(local.map((edit) => [editKey(edit), JSON.stringify(edit)]));
  const changedKeys = [...after].filter(([key, text]) => before.get(key) !== text).map(([key]) => key);
  const removedKeys = [...before.keys()].filter((key) => !after.has(key));
  return { changedKeys, removedKeys };
}

/**
 * Three-way merge of a basket written elsewhere since the writer's base: start from `stored`,
 * drop what the writer removed, then put the writer's changed edits in (in place of the same key,
 * or at the end). Keys nobody touched keep the stored version.
 */
export function mergeBaskets(stored: readonly Edit[], local: readonly Edit[], change: BasketChange): Edit[] {
  const removed = new Set(change.removedKeys);
  const changed = new Set(change.changedKeys);
  const next = stored.filter((edit) => !removed.has(editKey(edit)));
  for (const edit of local) {
    const key = editKey(edit);
    if (!changed.has(key)) continue;
    const index = next.findIndex((entry) => editKey(entry) === key);
    if (index === -1) next.push(edit);
    else next[index] = edit;
  }
  return next;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((label, index) => label === right[index]);
}
