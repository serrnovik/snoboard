/**
 * In-process event hub for `GET /api/events`. Per-user events (proposals, baskets) go only to
 * that user's connections; snapshot events carry no user data and go to everyone connected.
 */

export type BridgeEvent =
  | { type: "proposal"; id: string; repo: string; branch: string; status: "pending" | "accepted" | "rejected" }
  | { type: "basket"; repo: string; branch: string; updated: number; source: "browser" | "agent" | "inbox" }
  | { type: "snapshot"; repo: string; ref: string | null; at: string };

export const MAX_STREAMS_PER_USER = 10;
export const MAX_STREAMS = 200;

type Listener = (event: BridgeEvent) => void;

const streams = new Map<string, Set<Listener>>();
const snapshotListeners = new Set<(repo: string, ref: string | null) => void>();

function streamCount(): number {
  let total = 0;
  for (const set of streams.values()) total += set.size;
  return total;
}

/** Registers one SSE connection. Null when the user or the server has too many open. */
export function subscribe(userKey: string, listener: Listener): (() => void) | null {
  const set = streams.get(userKey) ?? new Set<Listener>();
  if (set.size >= MAX_STREAMS_PER_USER || streamCount() >= MAX_STREAMS) return null;
  set.add(listener);
  streams.set(userKey, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) streams.delete(userKey);
  };
}

export function publishToUser(userKey: string, event: BridgeEvent): void {
  for (const listener of streams.get(userKey) ?? []) {
    try {
      listener(event);
    } catch {
      // A closed stream drops its own listener.
    }
  }
}

export function publishSnapshot(repo: string, ref: string | null, at = new Date().toISOString()): void {
  const event: BridgeEvent = { type: "snapshot", repo, ref, at };
  for (const set of streams.values()) {
    for (const listener of set) {
      try {
        listener(event);
      } catch {
        // ignore
      }
    }
  }
  for (const listener of snapshotListeners) listener(repo, ref);
}

/** Tests: observe snapshot events without a stream. */
export function onSnapshotPublished(listener: (repo: string, ref: string | null) => void): () => void {
  snapshotListeners.add(listener);
  return () => snapshotListeners.delete(listener);
}

export function openStreams(userKey?: string): number {
  return userKey === undefined ? streamCount() : (streams.get(userKey)?.size ?? 0);
}

export function resetEvents(): void {
  streams.clear();
  snapshotListeners.clear();
}
