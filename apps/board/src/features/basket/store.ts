import { useCallback, useEffect, useState } from "react";
import { EditSchema, type Edit } from "snoboard/browser";
import { deleteImage } from "@/features/attachments/store";
import { useBasketBranch } from "@/features/repo/branch-context";

/** Single-repo boards use this id until a board lists more than one repository. */
export const DEFAULT_REPO_ID = "default";

const EMPTY: Edit[] = [];

const cache = new Map<string, Edit[]>();
const listeners = new Set<() => void>();

/** Branch a basket belongs to when nothing else is known. */
export const DEFAULT_BASKET_BRANCH = "main";

/** One basket per repository and branch: `snoboard:basket:v1:<repoId>:<branch>`. */
export function basketStorageKey(repoId: string, branch: string = DEFAULT_BASKET_BRANCH): string {
  return `snoboard:basket:v1:${repoId}:${branch}`;
}

/** The key used before baskets were kept per branch. Read once and moved to the default branch's basket. */
export function legacyBasketStorageKey(repoId: string): string {
  return `snoboard:basket:v1:${repoId}`;
}

type Scope = { repoId: string; branch: string; key: string; migrate: boolean };

function scopeOf(repoId: string, branch: string, isDefault: boolean): Scope {
  return { repoId, branch, key: basketStorageKey(repoId, branch), migrate: isDefault };
}

/** Pending edits saved for another branch, without subscribing to them. */
export function savedBasketCount(repoId: string, branch: string, isDefault = false): number {
  if (typeof window === "undefined") return 0;
  return current(scopeOf(repoId, branch, isDefault)).length;
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
  const { branch, isDefault } = useBasketBranch();
  const key = basketStorageKey(repoId, branch);
  const [edits, setEdits] = useState<readonly Edit[]>(() => readClient(scopeOf(repoId, branch, isDefault)));

  useEffect(() => {
    const scope = scopeOf(repoId, branch, isDefault);
    cache.set(scope.key, readBasket(scope));
    setEdits(cache.get(scope.key) ?? EMPTY);
    const listener = () => setEdits(cache.get(scope.key) ?? EMPTY);
    listeners.add(listener);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== scope.key) return;
      cache.set(scope.key, readBasket(scope));
      listener();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(listener);
      window.removeEventListener("storage", onStorage);
    };
  }, [repoId, branch, isDefault]);

  const publish = useCallback(
    (next: readonly Edit[]) => {
      const current = cache.get(key) ?? EMPTY;
      if (sameEdits(current, next)) return;
      const stored = next.length === 0 ? EMPTY : [...next];
      cache.set(key, stored);
      writeBasket(key, stored);
      for (const listener of listeners) listener();
    },
    [key],
  );
  const read = useCallback(() => readClient(scopeOf(repoId, branch, isDefault)), [repoId, branch, isDefault]);

  const add = useCallback(
    (edit: Edit) => {
      const parsed = EditSchema.safeParse(edit);
      if (!parsed.success) return;
      publish(mergeInto(read(), parsed.data));
    },
    [publish, read],
  );

  const remove = useCallback(
    (index: number) => {
      const current = read();
      if (index < 0 || index >= current.length) return;
      forgetImages([current[index]!]);
      publish(current.filter((_, entryIndex) => entryIndex !== index));
    },
    [publish, read],
  );

  const clear = useCallback(() => {
    forgetImages(read());
    publish(EMPTY);
  }, [publish, read]);

  const list = read;

  const retain = useCallback(
    (indices: readonly number[]) => {
      const current = read();
      const keep = new Set(indices);
      forgetImages(current.filter((_, index) => !keep.has(index)));
      publish(current.filter((_, index) => keep.has(index)));
    },
    [publish, read],
  );

  const insertBefore = useCallback(
    (index: number, added: readonly Edit[]) => {
      publish(insertEditsBefore(read(), index, added));
    },
    [publish, read],
  );

  const moveStatuses = useCallback(
    (
      columns: Readonly<Record<string, readonly { id: string }[]>>,
      snapshotStatus: (id: string) => string | undefined,
    ) => {
      publish(applyStatusColumns(read(), columns, snapshotStatus));
    },
    [publish, read],
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
    case "setIcon":
      return `icon ${edit.from === "" ? "(none)" : edit.from} → ${edit.to === "" ? "(none)" : edit.to}`;
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

function readClient(scope: Scope): readonly Edit[] {
  if (typeof window === "undefined") return EMPTY;
  return current(scope);
}

function current(scope: Scope): readonly Edit[] {
  const found = cache.get(scope.key);
  if (found !== undefined) return found;
  const loaded = readBasket(scope);
  cache.set(scope.key, loaded);
  return loaded;
}

/** A basket saved before baskets were per branch belongs to the default branch: move it there once. */
function migrateLegacy(scope: Scope): void {
  if (!scope.migrate) return;
  const legacy = legacyBasketStorageKey(scope.repoId);
  const raw = localStorage.getItem(legacy);
  if (raw === null) return;
  if (localStorage.getItem(scope.key) === null) localStorage.setItem(scope.key, raw);
  localStorage.removeItem(legacy);
}

function readBasket(scope: Scope): Edit[] {
  if (typeof localStorage === "undefined") return [];
  migrateLegacy(scope);
  const key = scope.key;
  const raw = localStorage.getItem(key);
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    writeBasket(key, EMPTY);
    return [];
  }
  if (!Array.isArray(parsed)) {
    writeBasket(key, EMPTY);
    return [];
  }
  const edits: Edit[] = [];
  for (const entry of parsed) {
    const result = EditSchema.safeParse(entry);
    if (result.success) edits.push(result.data);
  }
  if (edits.length !== parsed.length) writeBasket(key, edits);
  return edits;
}

function writeBasket(key: string, edits: readonly Edit[]): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(key, JSON.stringify(edits));
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
    case "setIcon":
      return next.kind === "setIcon" ? { ...next, from: existing.from } : next;
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
    case "setIcon":
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
