import { useCallback, useEffect, useState } from "react";
import { EditSchema, isNoOpEdit, mergeIntoBasket, sameEditTarget, withFirstFrom, type Edit } from "snoboard/browser";
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
  syncHooks = null;
  for (const listener of listeners) listener();
}

/**
 * Server-side basket sync (agent bridge). `onOpen` runs when a basket is shown, `onWrite` after
 * every local change. Without hooks the basket lives in localStorage only.
 */
export type BasketSyncHooks = {
  onOpen: (repoId: string, branch: string) => void;
  onWrite: (repoId: string, branch: string, edits: readonly Edit[]) => void;
};

let syncHooks: BasketSyncHooks | null = null;

/** Baskets on screen (`repo:branch` -> mounted users; repo ids have no colon), so hooks set later still open them. */
const openBaskets = new Map<string, number>();

export function setBasketSyncHooks(hooks: BasketSyncHooks | null): void {
  syncHooks = hooks;
  if (hooks === null) return;
  for (const scope of openBaskets.keys()) {
    const colon = scope.indexOf(":");
    hooks.onOpen(scope.slice(0, colon), scope.slice(colon + 1));
  }
}

/** The saved basket for a repository and branch (the cache, else localStorage). */
export function readSavedBasket(repoId: string, branch: string): readonly Edit[] {
  if (typeof window === "undefined") return EMPTY;
  return current(scopeOf(repoId, branch, false));
}

/** Replace a basket with the server's version. Does not call `onWrite` back. */
export function replaceSavedBasket(repoId: string, branch: string, edits: readonly Edit[]): void {
  if (typeof window === "undefined") return;
  const key = basketStorageKey(repoId, branch);
  const parsed = edits.flatMap((edit) => {
    const result = EditSchema.safeParse(edit);
    return result.success ? [result.data] : [];
  });
  if (sameEdits(cache.get(key) ?? readBasket(scopeOf(repoId, branch, false)), parsed)) return;
  const stored = parsed.length === 0 ? EMPTY : parsed;
  cache.set(key, stored);
  writeBasket(key, stored);
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
    const openKey = `${repoId}:${branch}`;
    openBaskets.set(openKey, (openBaskets.get(openKey) ?? 0) + 1);
    syncHooks?.onOpen(repoId, branch);
    return () => {
      const left = (openBaskets.get(openKey) ?? 1) - 1;
      if (left <= 0) openBaskets.delete(openKey);
      else openBaskets.set(openKey, left);
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
      syncHooks?.onWrite(repoId, branch, stored);
    },
    [key, repoId, branch],
  );
  const read = useCallback(() => readClient(scopeOf(repoId, branch, isDefault)), [repoId, branch, isDefault]);

  const add = useCallback(
    (edit: Edit) => {
      const parsed = EditSchema.safeParse(edit);
      if (!parsed.success) return;
      publish(mergeIntoBasket(read(), parsed.data));
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
    case "setDoc":
      return "edited";
    case "createDoc":
      return "new";
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

/** Title shown beside an edit. Snapshot title, the new title for a create, the document path, or the id. */
export function editTitle(edit: Edit, titles?: ReadonlyMap<string, string>): string {
  if (edit.kind === "createInitiative") return edit.title;
  if (edit.kind === "setDoc" || edit.kind === "createDoc") return edit.path;
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
        next = mergeIntoBasket(next, { kind: "setStatus", id: item.id, from, to: column });
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
    const existing = next.findIndex((entry) => sameEditTarget(entry, edit));
    if (existing !== -1) {
      edit = withFirstFrom(next[existing]!, edit);
      next = next.filter((_, entryIndex) => entryIndex !== existing);
      if (existing < at) at -= 1;
    }
    if (!isNoOpEdit(edit)) inserted.push(edit);
  }
  next.splice(at, 0, ...inserted);
  return next;
}

type DocEdit = Extract<Edit, { kind: "setDoc" | "createDoc" }>;

function isDocEdit(edit: Edit): edit is DocEdit {
  return edit.kind === "setDoc" || edit.kind === "createDoc";
}

/**
 * Pending document text per path (relative to the initiative folder, with `.md`) for
 * initiative `id`: the last `setDoc` / `createDoc` in the basket wins.
 */
export function pendingDocs(edits: readonly Edit[], id: string): Map<string, { text: string; created: boolean }> {
  const map = new Map<string, { text: string; created: boolean }>();
  for (const edit of edits) {
    if (!isDocEdit(edit) || edit.id !== id) continue;
    map.set(edit.path, { text: edit.to, created: edit.kind === "createDoc" });
  }
  return map;
}

function formatLabelList(labels: readonly string[]): string {
  return labels.length === 0 ? "(none)" : labels.join(", ");
}
