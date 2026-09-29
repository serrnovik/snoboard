import { useEffect, useState } from "react";
import { VERSION } from "snoboard/browser";
import { Button } from "@/components/ui/button";
import { Kanban, KanbanBoard, KanbanColumn, KanbanItem } from "@/components/ui/kanban";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BoardCard } from "@/features/board/Card";
import { DetailsDrawer } from "@/features/details/DetailsSheet";
import { setOpenId } from "@/features/details/open";
import { Filters } from "@/features/board/Filters";
import { LegacyList } from "@/features/board/LegacyList";
import {
  defaultBranchName,
  matchesFilters,
  parseBoardQuery,
  serializeBoardQuery,
  uniqueSorted,
  visibleColumnItems,
  formatRelativeTime,
  type BoardPayload,
  type BoardQuery,
} from "@/features/board/model";
import { rateLimitNote, useBoardResource } from "@/features/board/sync";

const POLL_MS = 60_000;
const EMPTY_MESSAGE = "No Snoboard initiatives yet — run `snoboard new`";

export function Board({
  pollIntervalMs = POLL_MS,
  now,
  refreshPollMs,
  refreshTimeoutMs,
}: {
  pollIntervalMs?: number;
  now?: number;
  refreshPollMs?: number;
  refreshTimeoutMs?: number;
}) {
  const [queryText, setQueryText] = useState("");
  const {
    phase,
    payload,
    loadError,
    reachError,
    actionError,
    rateLimited,
    refreshing,
    nowMs,
    refresh,
  } = useBoardResource({ pollIntervalMs, now, refreshPollMs, refreshTimeoutMs });

  useEffect(() => {
    setQueryText(window.location.search);
    const onPopState = () => setQueryText(window.location.search);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  function updateQuery(next: BoardQuery) {
    const search = serializeBoardQuery(window.location.search, next);
    const url = `${window.location.pathname}${search}${window.location.hash}`;
    window.history.pushState(window.history.state, "", url);
    setQueryText(window.location.search);
  }

  return (
    <TooltipProvider>
      <main className="flex w-full min-w-0 max-w-full flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3 px-4 pt-4">
          {payload !== null ? (
            <p className="text-sm text-muted-foreground">
              {payload.status.lastFetchAt === null
                ? "Not fetched yet"
                : `Last fetched ${formatRelativeTime(payload.status.lastFetchAt, nowMs)}`}
            </p>
          ) : null}
          <Button type="button" variant="outline" onClick={() => void refresh()} disabled={refreshing}>
            {refreshing ? "Refreshing…" : "Refresh"}
          </Button>
          {rateLimited ? <p className="text-sm text-muted-foreground">{rateLimitNote()}</p> : null}
        </div>
        {actionError !== null ? <ErrorBanner>{actionError}</ErrorBanner> : null}
        {reachError !== null ? <ErrorBanner>{reachError}</ErrorBanner> : null}
        {phase === "loading" ? <BoardSkeleton /> : null}
        {phase === "error" ? (
          <ErrorBanner>{loadError ?? "Could not load the board"}</ErrorBanner>
        ) : null}
        {phase === "ready" && payload !== null ? (
          <BoardBody
            payload={payload}
            query={parseBoardQuery(queryText)}
            nowMs={nowMs}
            onQueryChange={updateQuery}
          />
        ) : null}
        <footer className="mt-auto px-4 pb-4 text-sm text-muted-foreground">Snoboard {VERSION}</footer>
        <DetailsDrawer />
      </main>
    </TooltipProvider>
  );
}

function ErrorBanner({ children }: { children: string }) {
  return (
    <p role="alert" className="mx-4 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {children}
    </p>
  );
}

function BoardBody({
  payload,
  query,
  nowMs,
  onQueryChange,
}: {
  payload: BoardPayload;
  query: BoardQuery;
  nowMs: number;
  onQueryChange: (next: BoardQuery) => void;
}) {
  const filtered = payload.items.filter((item) => matchesFilters(item, query));
  const projects = uniqueSorted(payload.items.map((item) => item.project));
  const labels = uniqueSorted(payload.items.flatMap((item) => item.labels ?? []));
  const defaultBranch = defaultBranchName(payload.refs);
  const byStatus = payload.config.statuses.map((status) => ({
    status,
    column: visibleColumnItems(
      filtered,
      status,
      payload.config.doneStatuses,
      payload.config.priorities,
      query.showAllDone,
      nowMs,
    ),
  }));
  const columns = Object.fromEntries(byStatus.map(({ status, column }) => [status, column.visible]));
  const showAllHref = `${window.location.pathname}${serializeBoardQuery(window.location.search, {
    ...query,
    showAllDone: true,
  })}`;

  return (
    <>
      {payload.status.lastError !== null ? (
        <p role="alert" className="mx-4 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
          {payload.status.lastError}
        </p>
      ) : null}
      <div className="px-4">
        <Filters
          query={query}
          projects={projects}
          labels={labels}
          priorities={payload.config.priorities}
          onChange={onQueryChange}
        />
      </div>
      {payload.items.length === 0 ? (
        <p className="px-4 text-sm text-muted-foreground">{EMPTY_MESSAGE}</p>
      ) : filtered.length === 0 ? (
        <p className="px-4 text-sm text-muted-foreground">No initiatives match these filters.</p>
      ) : (
        <div data-testid="board-scroller" className="w-full min-w-0 overflow-x-scroll pb-2">
          <Kanban value={columns} getItemValue={(item) => item.id} sensors={[]}>
            <KanbanBoard className="h-auto! w-max! min-w-full items-start px-4">
              {byStatus.map(({ status, column }) => {
                const heading = statusHeading(status);
                return (
                  <KanbanColumn
                    key={status}
                    value={status}
                    data-testid={`column-${status}`}
                    aria-label={heading}
                    className="h-auto! w-[272px]! shrink-0! bg-muted dark:bg-muted"
                  >
                    <div className="flex items-center justify-between gap-2 px-1">
                      <h2 className="text-sm font-medium">{heading}</h2>
                      <span className="text-xs text-muted-foreground">{column.visible.length}</span>
                    </div>
                    {column.hidden > 0 ? (
                      <a
                        href={showAllHref}
                        className="px-1 text-xs underline"
                        onClick={(event) => {
                          event.preventDefault();
                          onQueryChange({ ...query, showAllDone: true });
                        }}
                      >
                        Show all
                      </a>
                    ) : null}
                    {column.visible.length === 0 ? (
                      <p className="px-1 text-xs text-muted-foreground">No initiatives</p>
                    ) : (
                      column.visible.map((item) => (
                        <KanbanItem key={item.id} value={item.id}>
                          <BoardCard
                            item={item}
                            doneStatuses={payload.config.doneStatuses}
                            defaultBranch={defaultBranch}
                            onOpen={setOpenId}
                          />
                        </KanbanItem>
                      ))
                    )}
                  </KanbanColumn>
                );
              })}
            </KanbanBoard>
          </Kanban>
        </div>
      )}
      {query.showLegacy ? (
        <div className="px-4">
          <LegacyList items={payload.legacy} />
        </div>
      ) : null}
    </>
  );
}

function BoardSkeleton() {
  return (
    <div data-testid="board-skeleton" aria-busy="true" aria-label="Loading board" className="flex w-full min-w-0 gap-4 overflow-x-scroll px-4">
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} className="flex w-[272px] shrink-0 flex-col gap-3">
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ))}
    </div>
  );
}

function statusHeading(status: string): string {
  const label = status.replaceAll("-", " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}
