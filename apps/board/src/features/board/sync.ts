import { useCallback, useEffect, useRef, useState } from "react";
import { isBoardPayload, type BoardPayload, type BoardStatus } from "@/features/board/model";
import { useRepoId } from "@/features/repo/context";
import { DEFAULT_REPO_ID } from "@/features/basket/store";
import { repoApi } from "@/lib/routes";

export const CLOCK_TICK_MS = 30_000;
export const REFRESH_POLL_MS = 1_000;
export const REFRESH_POLL_MAX_MS = 60_000;

const RATE_LIMIT_NOTE = "Try again in a moment";

export type BoardStatusStamp = {
  lastFetchAt: string | null;
  lastError: string | null;
};

export type FetchBoardResult =
  | { kind: "ok"; payload: BoardPayload }
  | { kind: "unauthorized" }
  | { kind: "aborted" }
  | { kind: "error"; message: string };

const SNAPSHOT_NOT_READY = "snapshot not ready";
const WARMUP_RETRY_MS = 2_000;
const WARMUP_TRIES = 30;

export type PollBoardResult =
  | { kind: "updated"; payload: BoardPayload }
  | { kind: "unauthorized" }
  | { kind: "aborted" }
  | { kind: "timeout" };

type PollOptions = {
  repoId?: string;
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  onFailure?: (message: string) => void;
  onReachable?: () => void;
};

export function reachErrorMessage(detail: string): string {
  return `Couldn't reach the board server: ${detail}`;
}

export function rateLimitNote(): string {
  return RATE_LIMIT_NOTE;
}

export function errorMessage(body: unknown, status: number): string {
  if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") {
    return body.error;
  }
  return `Could not load the board (${status})`;
}

export function statusStamp(status: BoardStatus): BoardStatusStamp {
  return {
    lastFetchAt: status.lastFetchAt,
    lastError: status.lastError,
  };
}

export function statusChanged(previous: BoardStatusStamp | null, next: BoardStatus): boolean {
  if (previous === null) return true;
  return previous.lastFetchAt !== next.lastFetchAt || previous.lastError !== next.lastError;
}

// Location.assign is not writable in jsdom, so tests observe this wrapper.
export const browserLocation = {
  assign(path: string): void {
    window.location.assign(path);
  },
  replace(path: string): void {
    window.location.replace(path);
  },
};

export function redirectToLogin(): void {
  if (typeof window === "undefined") return;
  if (window.location.pathname === "/login") return;
  browserLocation.assign("/login");
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortError());
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function fetchBoard(signal?: AbortSignal, repoId = DEFAULT_REPO_ID): Promise<FetchBoardResult> {
  try {
    const response = await fetch(repoApi(repoId, "/board"), { credentials: "same-origin", signal });
    if (signal?.aborted) return { kind: "aborted" };
    if (response.status === 401) {
      redirectToLogin();
      return { kind: "unauthorized" };
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok || !isBoardPayload(body)) {
      return { kind: "error", message: errorMessage(body, response.status) };
    }
    return { kind: "ok", payload: body };
  } catch (error) {
    if (isAbortError(error)) return { kind: "aborted" };
    return {
      kind: "error",
      message: error instanceof Error ? error.message : "Could not load the board",
    };
  }
}

export async function pollBoardUntilChange(
  previous: BoardStatusStamp | null,
  options: PollOptions = {},
): Promise<PollBoardResult> {
  const intervalMs = options.intervalMs ?? REFRESH_POLL_MS;
  const timeoutMs = options.timeoutMs ?? REFRESH_POLL_MAX_MS;
  const sleep = options.sleep ?? delay;
  const now = options.now ?? Date.now;
  const started = now();

  while (now() - started < timeoutMs) {
    if (options.signal?.aborted) return { kind: "aborted" };
    const outcome = await fetchBoard(options.signal, options.repoId);
    if (outcome.kind === "aborted") return { kind: "aborted" };
    if (outcome.kind === "unauthorized") return { kind: "unauthorized" };
    if (outcome.kind === "error") {
      options.onFailure?.(outcome.message);
    } else {
      options.onReachable?.();
      if (statusChanged(previous, outcome.payload.status)) {
        return { kind: "updated", payload: outcome.payload };
      }
    }
    const remaining = timeoutMs - (now() - started);
    if (remaining <= 0) break;
    try {
      await sleep(Math.min(intervalMs, remaining), options.signal);
    } catch (error) {
      if (isAbortError(error)) return { kind: "aborted" };
      throw error;
    }
  }
  return { kind: "timeout" };
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

export function useNow(fixed?: number): readonly [number, () => void] {
  const [clock, setClock] = useState(() => fixed ?? Date.now());
  useEffect(() => {
    if (fixed !== undefined) return;
    const timer = window.setInterval(() => setClock(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, [fixed]);
  const bump = useCallback(() => {
    if (fixed === undefined) setClock(Date.now());
  }, [fixed]);
  return [fixed ?? clock, bump] as const;
}

export function useBoardResource(options?: {
  repoId?: string;
  pollIntervalMs?: number;
  now?: number;
  refreshPollMs?: number;
  refreshTimeoutMs?: number;
}) {
  const contextRepo = useRepoId();
  const repoId = options?.repoId ?? contextRepo;
  const pollIntervalMs = options?.pollIntervalMs ?? 60_000;
  const refreshPollMs = options?.refreshPollMs ?? REFRESH_POLL_MS;
  const refreshTimeoutMs = options?.refreshTimeoutMs ?? REFRESH_POLL_MAX_MS;
  const [phase, setPhase] = useState<"loading" | "error" | "ready">("loading");
  const [payload, setPayload] = useState<BoardPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reachError, setReachError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [rateLimited, setRateLimited] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [nowMs, bumpNow] = useNow(options?.now);
  const payloadRef = useRef<BoardPayload | null>(null);
  const refreshAbort = useRef<AbortController | null>(null);

  const noteFailure = useCallback((message: string) => {
    if (payloadRef.current === null) {
      setLoadError(message);
      setPhase("error");
      return;
    }
    setReachError(reachErrorMessage(message));
  }, []);

  const commit = useCallback(
    (next: BoardPayload) => {
      payloadRef.current = next;
      setPayload(next);
      setLoadError(null);
      setReachError(null);
      setActionError(null);
      setPhase("ready");
      bumpNow();
    },
    [bumpNow],
  );

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    let warmup: number | undefined;
    let warmupTries = 0;

    async function load() {
      const outcome = await fetchBoard(controller.signal, repoId);
      if (cancelled || outcome.kind === "aborted" || outcome.kind === "unauthorized") return;
      if (outcome.kind === "error") {
        noteFailure(outcome.message);
        // Right after the server starts, the first clone is still running: retry soon instead of
        // waiting for the next poll.
        if (payloadRef.current === null && outcome.message === SNAPSHOT_NOT_READY && warmupTries < WARMUP_TRIES) {
          warmupTries += 1;
          window.clearTimeout(warmup);
          warmup = window.setTimeout(() => {
            void load();
          }, WARMUP_RETRY_MS);
        }
        return;
      }
      commit(outcome.payload);
    }

    void load();
    if (pollIntervalMs <= 0) {
      return () => {
        cancelled = true;
        controller.abort();
        window.clearTimeout(warmup);
      };
    }
    const timer = window.setInterval(() => {
      void load();
    }, pollIntervalMs);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
      window.clearTimeout(warmup);
    };
  }, [pollIntervalMs, reloadToken, commit, noteFailure, repoId]);

  useEffect(() => () => refreshAbort.current?.abort(), []);

  const refresh = useCallback(async () => {
    refreshAbort.current?.abort();
    const controller = new AbortController();
    refreshAbort.current = controller;
    setRefreshing(true);
    setActionError(null);
    setRateLimited(false);
    try {
      const response = await fetch(repoApi(repoId, "/refresh"), {
        method: "POST",
        credentials: "same-origin",
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (response.status === 401) {
        redirectToLogin();
        return;
      }
      if (response.status === 429) {
        setRateLimited(true);
        return;
      }
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        setActionError(errorMessage(body, response.status));
        return;
      }
      const previous = payloadRef.current === null ? null : statusStamp(payloadRef.current.status);
      const result = await pollBoardUntilChange(previous, {
        repoId,
        intervalMs: refreshPollMs,
        timeoutMs: refreshTimeoutMs,
        signal: controller.signal,
        onFailure: noteFailure,
        onReachable: () => {
          if (payloadRef.current !== null) setReachError(null);
        },
      });
      if (controller.signal.aborted || result.kind !== "updated") return;
      commit(result.payload);
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) return;
      setActionError(error instanceof Error ? error.message : "Refresh failed");
    } finally {
      if (refreshAbort.current === controller) setRefreshing(false);
    }
  }, [commit, noteFailure, refreshPollMs, refreshTimeoutMs, repoId]);

  const retry = useCallback(() => {
    if (payloadRef.current === null) {
      setPhase("loading");
      setLoadError(null);
    }
    setReloadToken((value) => value + 1);
  }, []);

  return {
    phase,
    payload,
    loadError,
    reachError,
    actionError,
    rateLimited,
    refreshing,
    nowMs,
    refresh,
    retry,
  };
}
