import type { Config, Snapshot } from "snoboard";

export type SyncStatus = {
  lastFetchAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  refreshing: boolean;
};

type StoreState = {
  snapshot: Snapshot | null;
  config: Config | null;
  status: SyncStatus;
};

function emptyStatus(): SyncStatus {
  return {
    lastFetchAt: null,
    lastError: null,
    lastErrorAt: null,
    refreshing: false,
  };
}

let state: StoreState = {
  snapshot: null,
  config: null,
  status: emptyStatus(),
};

export function getSnapshot(): Snapshot | null {
  return state.snapshot;
}

export function getConfig(): Config | null {
  return state.config;
}

export function getStatus(): SyncStatus {
  return { ...state.status };
}

export function setRefreshing(refreshing: boolean): void {
  state = {
    ...state,
    status: { ...state.status, refreshing },
  };
}

/** Replace the published snapshot in one assignment so readers never see a partial update. */
export function commitSnapshot(snapshot: Snapshot, config: Config, fetchedAt: string): void {
  state = {
    snapshot,
    config,
    status: {
      lastFetchAt: fetchedAt,
      lastError: null,
      lastErrorAt: null,
      refreshing: state.status.refreshing,
    },
  };
}

export function recordSyncError(message: string, at: string): void {
  state = {
    ...state,
    status: {
      ...state.status,
      lastError: message,
      lastErrorAt: at,
    },
  };
}

export function seedStore(snapshot: Snapshot, config: Config, fetchedAt = snapshot.generatedAt): void {
  commitSnapshot(snapshot, config, fetchedAt);
}

export function resetStore(): void {
  state = {
    snapshot: null,
    config: null,
    status: emptyStatus(),
  };
}
