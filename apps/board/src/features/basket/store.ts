import { useCallback, useEffect, useState } from "react";
import { EditSchema, type Edit } from "snoboard/browser";
import { deleteImage } from "@/features/attachments/store";

/** Single-repo boards use this id until a board lists more than one repository. */
export const DEFAULT_REPO_ID = "default";

const EMPTY: Edit[] = [];

const cache = new Map<string, Edit[]>();
const listeners = new Set<() => void>();

export function basketStorageKey(repoId: string): string {
  return `snoboard:basket:v1:${repoId}`;
}

export function resetBasketStore(): void {
  cache.clear();
  for (const listener of listeners) listener();
}

export function useBasket(repoId: string = DEFAULT_REPO_ID): {
  edits: readonly Edit[];
  add: (edit: Edit) => void;
  remove: (index: number) => void;
  clear: () => void;
  list: () => readonly Edit[];
  /** Keep only the edits at `indices`; images of the dropped ones are forgotten. */
  retain: (indices: readonly number[]) => void;
  /** Insert edits before `index`, replacing queued edits with the same target (their `from` is kept). */
  insertBefore: (index: number, edits: readonly Edit[]) => void;
  moveStatuses: (
    columns: Readonly<Record<string, readonly { id: string }[]>>,
    snapshotStatus: (id: string) => string | undefined,
  ) => void;
} {
  const [edits, setEdits] = useState<readonly Edit[]>(() => readClient(repoId));

  useEffect(() => {
    cache.set(repoId, readBasket(repoId));
    setEdits(cache.get(repoId) ?? EMPTY);
    const listener = () => setEdits(cache.get(repoId) ?? EMPTY);
    listeners.add(listener);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== basketStorageKey(repoId)) return;
      cache.set(repoId, readBasket(repoId));
      listener();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(listener);
      window.removeEventListener("storage", onStorage);
    };
  }, [repoId]);

  const publish = useCallback(
    (next: readonly Edit[]) => {
      const current = cache.get(repoId) ?? EMPTY;
      if (sameEdits(current, next)) return;
      const stored = next.length === 0 ? EMPTY : [...next];
      cache.set(repoId, stored);
      writeBasket(repoId, stored);
      for (const listener of listeners) listener();
    },
    [repoId],
  );

  const add = useCallback(
    (edit: Edit) => {
      const parsed = EditSchema.safeParse(edit);
      if (!parsed.success) return;
      publish(mergeInto(cache.get(repoId) ?? readClient(repoId), parsed.data));
    },
    [publish, repoId],
  );

  const remove = useCallback(
    (index: number) => {
      const current = cache.get(repoId) ?? readClient(repoId);
      if (index < 0 || index >= current.length) return;
      forgetImages([current[index]!]);
      publish(current.filter((_, entryIndex) => entryIndex !== index));
    },
    [publish, repoId],
  );

  const clear = useCallback(() => {
    forgetImages(cache.get(repoId) ?? readClient(repoId));
    publish(EMPTY);
  }, [publish, repoId]);

  const list = useCallback(() => cache.get(repoId) ?? readClient(repoId), [repoId]);

  const retain = useCallback(
    (indices: readonly number[]) => {
      const current = cache.get(repoId) ?? readClient(repoId);
      const keep = new Set(indices);
      forgetImages(current.filter((_, index) => !keep.has(index)));
      publish(current.filter((_, index) => keep.has(index)));
    },
    [publish, repoId],
  );

  const insertBefore = useCallback(
    (index: number, added: readonly Edit[]) => {
      publish(insertEditsBefore(cache.get(repoId) ?? readClient(repoId), index, added));
    },
    [publish, repoId],
  );

  const moveStatuses = useCallback(
    (
      columns: Readonly<Record<string, readonly { id: string }[]>>,
      snapshotStatus: (id: string) => string | undefined,
    ) => {
      publish(applyStatusColumns(cache.get(repoId) ?? readClient(repoId), columns, snapshotStatus));
    },
    [publish, repoId],
  );

  return { edits, add, remove, clear, list, retain, insertBefore, moveStatuses };
}

export function pendingEditsFor(edits: readonly Edit[], id: string): Edit[] {
  return edits.filter((edit) => "id" in edit && edit.id === id);
}

export function formatPending(edit: Edit): string {
  switch (edit.kind) {
    case "setStatus":
      return `${edit.from} → ${edit.to}`;
    case "setPriority":
      return `priority ${edit.from} → ${edit.to}`;
    case "setPhaseStatus":
      return `phase ${edit.phase} ${edit.from} → ${edit.to}`;
    case "setTitle":
      return `title ${edit.from} → ${edit.to}`;
    case "setLabels":
      return `labels ${formatLabelList(edit.from)} → ${formatLabelList(edit.to)}`;
    case "setBody":
      return "body";
    case "setIssues":
      return `issues ${formatLabelList(edit.from)} → ${formatLabelList(edit.to)}`;
    case "setLinks":
      return `links ${edit.from.length} → ${edit.to.length}`;
    case "addAttachment":
      return `image ${edit.path}`;
    case "createInitiative":
      return `create ${edit.project}/${edit.slug}: ${edit.title}`;
  }
}

/** Deletes the IndexedDB bytes behind attachment edits that leave the basket. */
export function forgetImages(edits: readonly Edit[]): void {
  if (typeof window === "undefined") return;
  for (const edit of edits) {
    if (edit.kind === "addAttachment" && edit.key !== undefined) void deleteImage(edit.key);
  }
}

/** Title shown beside an edit. Snapshot title, the new title for a create, or the id. */
export function editTitle(edit: Edit, titles?: ReadonlyMap<string, string>): string {
  if (edit.kind === "createInitiative") return edit.title;
  const known = titles?.get(edit.id);
  if (known !== undefined && known.trim().length > 0) return known;
  return edit.id;
}

export function describeEdit(edit: Edit, titles?: ReadonlyMap<string, string>): string {
  const title = editTitle(edit, titles);
  if (edit.kind === "createInitiative") return `${edit.project}/${edit.slug} · ${title} — create`;
  return `${edit.id} · ${title} — ${formatPending(edit)}`;
}

function readClient(repoId: string): readonly Edit[] {
  if (typeof window === "undefined") return EMPTY;
  return current(repoId);
}

function current(repoId: string): readonly Edit[] {
  const found = cache.get(repoId);
  if (found !== undefined) return found;
  const loaded = readBasket(repoId);
  cache.set(repoId, loaded);
  return loaded;
}

function readBasket(repoId: string): Edit[] {
  if (typeof localStorage === "undefined") return [];
  const key = basketStorageKey(repoId);
  const raw = localStorage.getItem(key);
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    writeBasket(repoId, EMPTY);
    return [];
  }
  if (!Array.isArray(parsed)) {
    writeBasket(repoId, EMPTY);
    return [];
  }
  const edits: Edit[] = [];
  for (const entry of parsed) {
    const result = EditSchema.safeParse(entry);
    if (result.success) edits.push(result.data);
  }
  if (edits.length !== parsed.length) writeBasket(repoId, edits);
  return edits;
}

function writeBasket(repoId: string, edits: readonly Edit[]): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(basketStorageKey(repoId), JSON.stringify(edits));
}

function sameEdits(left: readonly Edit[], right: readonly Edit[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function applyStatusColumns(
  edits: readonly Edit[],
  columns: Readonly<Record<string, readonly { id: string }[]>>,
  snapshotStatus: (id: string) => string | undefined,
): Edit[] {
  let next = [...edits];
  for (const [column, items] of Object.entries(columns)) {
    for (const item of items) {
      const from = snapshotStatus(item.id);
      if (from === undefined) continue;
      if (column === from) {
        next = next.filter((edit) => !(edit.kind === "setStatus" && edit.id === item.id));
      } else {
        next = mergeInto(next, { kind: "setStatus", id: item.id, from, to: column });
      }
    }
  }
  return next;
}

/** Exported for tests. Parsed edits only; a same-target edit already queued is replaced in place of the new one. */
export function insertEditsBefore(edits: readonly Edit[], index: number, added: readonly Edit[]): Edit[] {
  let next = [...edits];
  let at = Math.max(0, Math.min(index, next.length));
  const inserted: Edit[] = [];
  for (const raw of added) {
    const parsed = EditSchema.safeParse(raw);
    if (!parsed.success) continue;
    let edit = parsed.data;
    const existing = next.findIndex((entry) => sameTarget(entry, edit));
    if (existing !== -1) {
      edit = withFirstFrom(next[existing]!, edit);
      next = next.filter((_, entryIndex) => entryIndex !== existing);
      if (existing < at) at -= 1;
    }
    if (!isNoOp(edit)) inserted.push(edit);
  }
  next.splice(at, 0, ...inserted);
  return next;
}

function mergeInto(edits: readonly Edit[], next: Edit): Edit[] {
  if (next.kind === "createInitiative") return [...edits, next];
  if (next.kind === "addAttachment") {
    const same = edits.some((edit) => edit.kind === "addAttachment" && edit.id === next.id && edit.path === next.path);
    return same ? [...edits] : [...edits, next];
  }
  const index = edits.findIndex((edit) => sameTarget(edit, next));
  if (index === -1) {
    if (isNoOp(next)) return [...edits];
    return [...edits, next];
  }
  const merged = withFirstFrom(edits[index]!, next);
  if (isNoOp(merged)) return edits.filter((_, entryIndex) => entryIndex !== index);
  const copy = [...edits];
  copy[index] = merged;
  return copy;
}

function sameTarget(left: Edit, right: Edit): boolean {
  if (left.kind === "createInitiative" || right.kind === "createInitiative") return false;
  if (left.kind === "addAttachment" || right.kind === "addAttachment") return false;
  if (left.kind !== right.kind || left.id !== right.id) return false;
  if (left.kind === "setPhaseStatus" && right.kind === "setPhaseStatus") return left.phase === right.phase;
  return true;
}

function withFirstFrom(existing: Edit, next: Edit): Edit {
  switch (existing.kind) {
    case "setBody":
      return next.kind === "setBody" ? { ...next, fromHash: existing.fromHash } : next;
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
    case "setPhaseStatus":
      return next.kind === "setPhaseStatus" ? { ...next, from: existing.from } : next;
    case "createInitiative":
    case "addAttachment":
      return next;
  }
}

function isNoOp(edit: Edit): boolean {
  switch (edit.kind) {
    case "setBody":
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
    case "setPhaseStatus":
      return edit.from === edit.to;
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((label, index) => label === right[index]);
}

function formatLabelList(labels: readonly string[]): string {
  return labels.length === 0 ? "(none)" : labels.join(", ");
}
