import { useSyncExternalStore } from "react";
import type { Edit } from "snoboard/browser";

export type ValidateResult = {
  index: number;
  ok: boolean;
  error?: string;
};

type Entry = { key: string; results: readonly ValidateResult[] };

const latest = new Map<string, Entry>();
const listeners = new Set<() => void>();

function keyOf(edits: readonly Edit[]): string {
  return JSON.stringify(edits);
}

/** Remember the last validation of `edits` so the basket panel can badge failing rows. */
export function recordValidation(repoId: string, edits: readonly Edit[], results: readonly ValidateResult[]): void {
  latest.set(repoId, { key: keyOf(edits), results });
  for (const listener of listeners) listener();
}

export function resetValidationStore(): void {
  latest.clear();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Errors by edit index from the last validation, or an empty map when the
 * basket changed since (indices would no longer line up).
 */
export function useValidationErrors(repoId: string, edits: readonly Edit[]): ReadonlyMap<number, string> {
  const entry = useSyncExternalStore(
    subscribe,
    () => latest.get(repoId),
    () => undefined,
  );
  if (entry === undefined || entry.key !== keyOf(edits)) return EMPTY;
  return new Map(entry.results.filter((result) => !result.ok).map((result) => [result.index, readableError(result.error)]));
}

const EMPTY: ReadonlyMap<number, string> = new Map();

/**
 * Turn a server message like `acme-001: phases: phase 3 has status "in-progress" while the initiative is done`
 * into a sentence: the id and the field prefix are already shown on the row.
 */
export function readableError(error: string | undefined): string {
  if (error === undefined || error.trim().length === 0) return "This edit is invalid.";
  const parts = error.split("; ").map((part) => {
    let text = part.replace(/^[a-z0-9_-]+-\d{3}: /i, "");
    text = text.replace(/^[a-z_]+: (?=\S)/i, "");
    if (text === "stale") return "The initiative changed since this edit was made. Remove it and edit again.";
    if (text.length === 0) return part;
    return text.charAt(0).toUpperCase() + text.slice(1);
  });
  return parts.map((part) => (/[.!?]$/.test(part) ? part : `${part}.`)).join(" ");
}

export type QuickFix = { label: string; edits: Edit[] };

const OPEN_PHASE = /phase (\d+) has status "([^"]+)" while the initiative is done/g;

/** A one-click fix for a failing edit, when one is known. */
export function quickFixFor(edit: Edit | undefined, error: string | undefined): QuickFix | undefined {
  if (edit?.kind !== "setStatus" || error === undefined) return undefined;
  const edits: Edit[] = [];
  for (const match of error.matchAll(OPEN_PHASE)) {
    edits.push({ kind: "setPhaseStatus", id: edit.id, phase: Number(match[1]), from: match[2]!, to: edit.to });
  }
  if (edits.length === 0) return undefined;
  return { label: edits.length === 1 ? "Also mark the open phase done" : "Also mark open phases done", edits };
}
