import type { Config, Snapshot } from "snoboard";
import { resetProposals } from "./proposals.js";

/** Single-repo deployments use this id when `SNOBOARD_REPOS_FILE` is unset. */
export const DEFAULT_REPO_ID = "default";

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

function emptyState(): StoreState {
  return {
    snapshot: null,
    config: null,
    status: emptyStatus(),
  };
}

const repos = new Map<string, StoreState>();

function slot(repoId: string): StoreState {
  let state = repos.get(repoId);
  if (state === undefined) {
    state = emptyState();
    repos.set(repoId, state);
  }
  return state;
}

/** Register a repo before its first sync so readiness waits for every configured id. */
export function registerRepo(repoId: string): void {
  slot(repoId);
}

export function getSnapshot(repoId = DEFAULT_REPO_ID): Snapshot | null {
  return repos.get(repoId)?.snapshot ?? null;
}

export function getConfig(repoId = DEFAULT_REPO_ID): Config | null {
  return repos.get(repoId)?.config ?? null;
}

export function getStatus(repoId = DEFAULT_REPO_ID): SyncStatus {
  const state = repos.get(repoId);
  if (state === undefined) return emptyStatus();
  return { ...state.status };
}

export function setRefreshing(refreshing: boolean, repoId = DEFAULT_REPO_ID): void {
  const state = slot(repoId);
  repos.set(repoId, {
    ...state,
    status: { ...state.status, refreshing },
  });
}

/** Replace the published snapshot in one assignment so readers never see a partial update. */
export function commitSnapshot(
  snapshot: Snapshot,
  config: Config,
  fetchedAt: string,
  repoId = DEFAULT_REPO_ID,
): void {
  const state = slot(repoId);
  repos.set(repoId, {
    snapshot,
    config,
    status: {
      lastFetchAt: fetchedAt,
      lastError: null,
      lastErrorAt: null,
      refreshing: state.status.refreshing,
    },
  });
}

export function recordSyncError(message: string, at: string, repoId = DEFAULT_REPO_ID): void {
  const state = slot(repoId);
  repos.set(repoId, {
    ...state,
    status: {
      ...state.status,
      lastError: message,
      lastErrorAt: at,
    },
  });
}

export function seedStore(
  snapshot: Snapshot,
  config: Config,
  fetchedAt = snapshot.generatedAt,
  repoId = DEFAULT_REPO_ID,
): void {
  commitSnapshot(snapshot, config, fetchedAt, repoId);
}

/** Ready once every registered repo has a snapshot or a recorded error. */
export function isBoardReady(): boolean {
  if (repos.size === 0) return false;
  for (const state of repos.values()) {
    if (state.snapshot === null && state.status.lastError === null) return false;
  }
  return true;
}

export function resetStore(): void {
  resetProposals();
  repos.clear();
}
