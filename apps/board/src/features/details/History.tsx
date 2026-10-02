import { useCallback, useEffect, useState } from "react";
import type { HistoryCommit } from "snoboard/browser";
import { formatAge } from "@/features/board/age";
import { redirectToLogin } from "@/features/board/sync";
import { useRepoId } from "@/features/repo/context";
import { repoApi } from "@/lib/routes";
import { forgeCommitUrl, type ForgeLinkConfig } from "./links.js";

type HistoryState = {
  commits: HistoryCommit[];
  hasMore: boolean;
  loading: boolean;
  error: string | null;
};

export function isHistoryPage(value: unknown): value is { commits: HistoryCommit[]; hasMore: boolean } {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.hasMore === "boolean" &&
    Array.isArray(record.commits) &&
    record.commits.every(
      (commit: unknown) =>
        typeof commit === "object" &&
        commit !== null &&
        typeof (commit as HistoryCommit).sha === "string" &&
        typeof (commit as HistoryCommit).date === "string" &&
        typeof (commit as HistoryCommit).author === "string" &&
        typeof (commit as HistoryCommit).subject === "string",
    )
  );
}

/** Default-branch commits that touched the initiative folder, newest first, 20 at a time. */
export function HistorySection({ id, forge, now }: { id: string; forge: ForgeLinkConfig; now?: number }) {
  const repoId = useRepoId();
  const [state, setState] = useState<HistoryState>({ commits: [], hasMore: false, loading: true, error: null });

  const load = useCallback(
    async (skip: number, signal?: AbortSignal) => {
      setState((current) => ({ ...current, loading: true, error: null }));
      try {
        const response = await fetch(repoApi(repoId, `/initiatives/${encodeURIComponent(id)}/history?skip=${skip}`), {
          credentials: "same-origin",
          signal,
        });
        if (response.status === 401) {
          redirectToLogin();
          return;
        }
        const body: unknown = await response.json().catch(() => null);
        if (signal?.aborted) return;
        if (!response.ok || !isHistoryPage(body)) {
          setState((current) => ({ ...current, loading: false, error: "Could not load the history" }));
          return;
        }
        setState((current) => ({
          commits: skip === 0 ? body.commits : [...current.commits, ...body.commits],
          hasMore: body.hasMore,
          loading: false,
          error: null,
        }));
      } catch {
        if (signal?.aborted) return;
        setState((current) => ({ ...current, loading: false, error: "Could not load the history" }));
      }
    },
    [id, repoId],
  );

  useEffect(() => {
    const controller = new AbortController();
    setState({ commits: [], hasMore: false, loading: true, error: null });
    void load(0, controller.signal);
    return () => controller.abort();
  }, [load]);

  const nowMs = now ?? Date.now();
  return (
    <section className="flex flex-col gap-2 text-sm" data-testid="history">
      <h2 className="font-medium">History</h2>
      {state.error !== null ? <p className="text-muted-foreground">{state.error}</p> : null}
      {!state.loading && state.error === null && state.commits.length === 0 ? (
        <p className="text-muted-foreground">No commits on the default branch yet.</p>
      ) : null}
      {state.commits.length > 0 ? (
        <ol className="flex flex-col gap-1.5">
          {state.commits.map((commit) => {
            const href = forgeCommitUrl(forge, commit.sha);
            const short = commit.sha.slice(0, 7);
            const age = formatAge(commit.date, nowMs);
            return (
              <li key={commit.sha} className="flex min-w-0 flex-col" data-testid="history-commit">
                <span className="min-w-0 truncate" title={commit.subject}>
                  {commit.subject}
                </span>
                <span className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                  {href !== null ? (
                    <a className="font-mono underline" href={href} rel="noopener noreferrer" target="_blank">
                      {short}
                    </a>
                  ) : (
                    <span className="font-mono">{short}</span>
                  )}
                  <time dateTime={commit.date} title={commit.date}>
                    {age === null ? commit.date : age === "now" ? "just now" : `${age} ago`}
                  </time>
                  <span>{commit.author}</span>
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}
      {state.loading ? <p className="text-muted-foreground">Loading history…</p> : null}
      {state.hasMore && !state.loading ? (
        <button
          type="button"
          className="w-fit text-primary underline-offset-4 hover:underline"
          onClick={() => void load(state.commits.length)}
        >
          Show more
        </button>
      ) : null}
    </section>
  );
}
