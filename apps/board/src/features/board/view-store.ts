import { useSyncExternalStore } from "react";
import type { InitiativePeople } from "snoboard/browser";
import type { EffectiveItem } from "@/features/board/effective";

/** The board's effective (basket-aware) items, shared with the details panel. */
export type BoardView = {
  items: ReadonlyMap<string, EffectiveItem>;
  people: Readonly<Record<string, InitiativePeople>>;
};

let current: BoardView | null = null;
const listeners = new Set<() => void>();

export function publishBoardView(view: BoardView | null): void {
  current = view;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBoardView(): BoardView | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}
