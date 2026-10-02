import { ChevronLeft, ChevronRight, GripVertical } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { type BoardItem, type Edit, type InitiativePeople } from "snoboard/browser";
import { AppVersion } from "@/components/app-version";
import { PageActionsPortal } from "@/components/page-actions";
import { Button } from "@/components/ui/button";
import { Kanban, KanbanBoard, KanbanColumn, KanbanItem, KanbanItemHandle, KanbanOverlay, useKanbanDrop } from "@/components/ui/kanban";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BasketPanel } from "@/features/basket/BasketPanel";
import { useEditConfig } from "@/features/basket/edit-config";
import { NewInitiativeDialog } from "@/features/basket/NewInitiativeDialog";
import { pendingEditsFor, useBasket } from "@/features/basket/store";
import { useRepoId } from "@/features/repo/context";
import { BoardCard } from "@/features/board/Card";
import { DetailsDrawer } from "@/features/details/DetailsSheet";
import { setOpenId } from "@/features/details/open";
import { Filters } from "@/features/board/Filters";
import { useFoldedColumns } from "@/features/board/folded";
import { LegacyList } from "@/features/board/LegacyList";
import {
  defaultBranchName,
  matchesFilters,
  parseBoardQuery,
  proposalsFor,
  readProposals,
  serializeBoardQuery,
  uniqueSorted,
  visibleColumnItems,
  formatRelativeTime,
  type BoardPayload,
  type BoardQuery,
  type Proposal,
  DEFAULT_STALE_AFTER_DAYS,
  isClosedStatus,
  isStale,
  showsAllClosed,
  toggleShowAllClosed,
} from "@/features/board/model";
import { rateLimitNote, useBoardResource } from "@/features/board/sync";
import { effectiveItems } from "@/features/board/effective";
import {
  CLOSED_AGE_OPTIONS,
  COLUMN_SORT_OPTIONS,
  compareBy,
  DEFAULT_CLOSED_AGE,
  DEFAULT_COLUMN_SORT,
  isClosedAge,
  isColumnSort,
  useClosedAges,
  useColumnSorts,
  type ClosedAge,
  type ColumnSort,
} from "@/features/board/columns";
import { publishBoardView } from "@/features/board/view-store";

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
  const editConfig = useEditConfig();
  const editing = editConfig.ready && editConfig.enabled;

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
            editing={editing}
            canSubmit={editConfig.canSubmit}
            onQueryChange={updateQuery}
          />
        ) : null}
        <footer className="mt-auto px-4 pb-4 text-sm text-muted-foreground"><AppVersion /></footer>
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
  editing,
  canSubmit,
  onQueryChange,
}: {
  payload: BoardPayload;
  query: BoardQuery;
  nowMs: number;
  editing: boolean;
  canSubmit: boolean;
  onQueryChange: (next: BoardQuery) => void;
}) {
  const repoId = useRepoId();
  const basket = useBasket(repoId);
  const { folded, toggle: toggleFolded } = useFoldedColumns(repoId);
  const staleAfterDays = payload.config.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;
  const staleIds = new Set(
    payload.items
      .filter((item) => isStale(item, payload.config.doneStatuses, staleAfterDays, nowMs))
      .map((item) => item.id),
  );
  const pending = editing ? basket.edits : NO_EDITS;
  const ages = useClosedAges(repoId);
  const sorts = useColumnSorts(repoId);
  const effective = useMemo(
    () => effectiveItems(payload.items, pending, payload.config.doneStatuses),
    [payload.items, pending, payload.config.doneStatuses],
  );
  const people = payload.people ?? NO_PEOPLE;
  useEffect(() => {
    publishBoardView({ items: new Map(effective.map((item) => [item.id, item])), people });
    return () => publishBoardView(null);
  }, [effective, people]);
  const pendingStatusIds = new Set(pending.flatMap((edit) => (edit.kind === "setStatus" ? [edit.id] : [])));
  const matching = effective.filter((item) => matchesFilters(item, query));
  const filtered = query.hideStale ? matching.filter((item) => !staleIds.has(item.id)) : matching;
  const staleCount = matching.length - matching.filter((item) => !staleIds.has(item.id)).length;
  const projects = uniqueSorted(payload.items.map((item) => item.project));
  const labels = uniqueSorted(payload.items.flatMap((item) => item.labels ?? []));
  const defaultBranch = defaultBranchName(payload.refs);
  const ageFor = (status: string): ClosedAge =>
    showsAllClosed(query.showAllClosed, status) ? "all" : (ages.values[status] ?? DEFAULT_CLOSED_AGE);
  const sortFor = (status: string): ColumnSort => sorts.values[status] ?? DEFAULT_COLUMN_SORT;
  const byStatus = payload.config.statuses.map((status) => ({
    status,
    column: visibleColumnItems(
      filtered,
      status,
      payload.config.doneStatuses,
      payload.config.priorities,
      false,
      nowMs,
      { age: ageFor(status), sort: sortFor(status), pendingIds: pendingStatusIds },
    ),
  }));
  const columns = Object.fromEntries(byStatus.map(({ status, column }) => [status, column.visible]));
  const closedStatuses = payload.config.statuses.filter((status) => isClosedStatus(status, payload.config.doneStatuses));
  const setAge = (status: string, age: ClosedAge) => {
    ages.set(status, age);
    // A URL override (closed=all or closed=<status>) wins over the stored age; drop it for this column.
    if (showsAllClosed(query.showAllClosed, status)) {
      onQueryChange({ ...query, showAllClosed: toggleShowAllClosed(query.showAllClosed, status, closedStatuses) });
    }
  };
  const snapshotStatus = new Map(payload.items.map((item) => [item.id, item.status]));
  const titleById = new Map(payload.items.map((item) => [item.id, item.title]));
  const byId = new Map(filtered.map((item) => [item.id, item]));
  const proposals = readProposals(payload.proposals);

  return (
    <>
      <BasketPanel enabled={editing} canSubmit={canSubmit} repoId={repoId} titles={titleById} />
      {editing ? (
        <PageActionsPortal>
          <NewInitiativeDialog
            projects={projects}
            initiatives={payload.items.map((item) => ({
              id: item.id,
              title: item.title,
              done: payload.config.doneStatuses.includes(item.status),
            }))}
            statuses={payload.config.statuses}
            priorities={payload.config.priorities}
            defaultProject={query.project}
          />
        </PageActionsPortal>
      ) : null}
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
          staleCount={staleCount}
          staleAfterDays={staleAfterDays}
          onChange={onQueryChange}
        />
      </div>
      {payload.items.length === 0 ? (
        <p className="px-4 text-sm text-muted-foreground">{EMPTY_MESSAGE}</p>
      ) : filtered.length === 0 ? (
        <p className="px-4 text-sm text-muted-foreground">No initiatives match these filters.</p>
      ) : (
        <div data-testid="board-scroller" className="w-full min-w-0 overflow-x-scroll bg-background pb-2">
          <Kanban
            value={columns}
            getItemValue={(item) => item.id}
            {...(editing
              ? {
                  onValueChange: (next: Record<string, BoardItem[]>) => {
                    // Kanban calls this from onDragEnd, after the pointer is released.
                    basket.moveStatuses(next, (id) => snapshotStatus.get(id));
                  },
                }
              : { sensors: [] })}
          >
            <KanbanBoard className="h-auto! w-max! min-w-full items-start px-4">
              {byStatus.map(({ status, column }) => {
                const heading = statusHeading(status);
                const total = column.visible.length + column.hidden;
                const isFolded = folded.has(status);
                const foldButton = (
                  <button
                    type="button"
                    aria-expanded={!isFolded}
                    aria-label={`${isFolded ? "Unfold" : "Fold"} ${heading}`}
                    data-testid={`fold-${status}`}
                    onClick={() => toggleFolded(status)}
                    className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    {isFolded ? <ChevronRight aria-hidden="true" /> : <ChevronLeft aria-hidden="true" />}
                  </button>
                );
                if (isFolded) {
                  return (
                    <KanbanColumn
                      key={status}
                      value={status}
                      data-testid={`column-${status}`}
                      data-folded="true"
                      aria-label={heading}
                      className="h-auto! min-h-48 w-10! shrink-0! items-center px-1! bg-muted dark:bg-muted"
                    >
                      {foldButton}
                      <h2 className="text-sm font-medium [writing-mode:vertical-rl]">{heading}</h2>
                      <span className="text-xs text-muted-foreground" data-testid={`count-${status}`}>
                        {total}
                      </span>
                    </KanbanColumn>
                  );
                }
                return (
                  <KanbanColumn
                    key={status}
                    value={status}
                    data-testid={`column-${status}`}
                    aria-label={heading}
                    className="h-auto! w-[272px]! shrink-0! bg-muted dark:bg-muted"
                  >
                    <div className="flex items-center justify-between gap-2 px-1">
                      <div className="flex min-w-0 items-center gap-1">
                        {foldButton}
                        <h2 className="text-sm font-medium">{heading}</h2>
                      </div>
                      <span className="text-xs text-muted-foreground" data-testid={`count-${status}`}>
                        {column.hidden > 0 ? `${total} · ${column.visible.length} shown` : total}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 px-1 text-xs text-muted-foreground">
                      <ColumnSelect
                        label={`Sort ${heading}`}
                        testId={`sort-${status}`}
                        value={sortFor(status)}
                        options={COLUMN_SORT_OPTIONS}
                        onChange={(value) => {
                          if (isColumnSort(value)) sorts.set(status, value);
                        }}
                      />
                      {column.closed ? (
                        <ColumnSelect
                          label={`Show ${heading} changed within`}
                          testId={`age-${status}`}
                          value={ageFor(status)}
                          options={editing ? CLOSED_AGE_OPTIONS : CLOSED_AGE_OPTIONS.filter((option) => option.value !== "session")}
                          onChange={(value) => {
                            if (isClosedAge(value)) setAge(status, value);
                          }}
                        />
                      ) : null}
                    </div>
                    <ColumnCards
                      status={status}
                      items={column.visible}
                      priorities={payload.config.priorities}
                      sort={sortFor(status)}
                      people={people}
                      byId={byId}
                      editing={editing}
                      doneStatuses={payload.config.doneStatuses}
                      defaultBranch={defaultBranch}
                      staleIds={staleIds}
                      pending={pending}
                      proposals={proposals}
                      titles={titleById}
                    />
                  </KanbanColumn>
                );
              })}
            </KanbanBoard>
            <DragGhost items={filtered} />
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

function ColumnCards({
  status,
  items,
  priorities,
  sort,
  people,
  byId,
  editing,
  doneStatuses,
  defaultBranch,
  staleIds,
  pending,
  proposals,
  titles,
}: {
  status: string;
  items: BoardItem[];
  priorities: readonly string[];
  sort: ColumnSort;
  people: Readonly<Record<string, InitiativePeople>>;
  byId: ReadonlyMap<string, BoardItem>;
  editing: boolean;
  doneStatuses: readonly string[];
  defaultBranch: string | null;
  staleIds: ReadonlySet<string>;
  pending: readonly Edit[];
  proposals: readonly Proposal[];
  titles: ReadonlyMap<string, string>;
}) {
  const drop = useKanbanDrop();
  const showSlot = drop.dropColumnId === status && drop.activeColumnId !== null && drop.activeColumnId !== status;
  const dragged = showSlot && drop.activeId != null ? byId.get(String(drop.activeId)) : undefined;
  const slotAt = dragged === undefined ? -1 : landingIndex(items, dragged, priorities, sort);

  if (items.length === 0 && slotAt < 0) {
    return <p className="px-1 text-xs text-muted-foreground">No initiatives</p>;
  }

  const rows: ReactNode[] = [];
  items.forEach((item, index) => {
    if (index === slotAt) rows.push(<DropPlaceholder key="drop-placeholder" />);
    rows.push(
      <KanbanItem key={item.id} value={item.id}>
        {editing ? (
          <div className="flex items-start gap-1">
            <KanbanItemHandle
              aria-label={`Drag ${item.id}`}
              data-testid={`drag-${item.id}`}
              className="mt-3 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground"
            >
              <GripVertical aria-hidden="true" />
            </KanbanItemHandle>
            <div className="min-w-0 flex-1">
              <BoardCard
                item={item}
                doneStatuses={doneStatuses}
                defaultBranch={defaultBranch}
                stale={staleIds.has(item.id)}
                pending={pendingEditsFor(pending, item.id)}
                proposed={proposalsFor(proposals, item.id)}
                titles={titles}
                people={people[item.id]}
                onOpen={setOpenId}
              />
            </div>
          </div>
        ) : (
          <BoardCard
            item={item}
            doneStatuses={doneStatuses}
            defaultBranch={defaultBranch}
            stale={staleIds.has(item.id)}
            proposed={proposalsFor(proposals, item.id)}
            titles={titles}
            people={people[item.id]}
            onOpen={setOpenId}
          />
        )}
      </KanbanItem>,
    );
  });
  if (slotAt >= items.length) rows.push(<DropPlaceholder key="drop-placeholder" />);
  return <>{rows}</>;
}

function DropPlaceholder() {
  return (
    <div
      data-testid="drop-placeholder"
      aria-hidden="true"
      className="pointer-events-none h-12 shrink-0 rounded-md border-2 border-dashed border-primary bg-primary/15"
    />
  );
}

function DragGhost({ items }: { items: readonly BoardItem[] }) {
  return (
    <KanbanOverlay>
      {({ value, variant }) => {
        if (variant !== "item") return null;
        const item = items.find((entry) => entry.id === value);
        if (item === undefined) return null;
        return (
          <div className="w-[240px] rounded-lg bg-card p-3 shadow-lg ring-2 ring-primary">
            <p className="font-mono text-xs text-muted-foreground">{item.id}</p>
            <p className="text-sm font-medium">{item.title}</p>
          </div>
        );
      }}
    </KanbanOverlay>
  );
}

function landingIndex(
  items: readonly BoardItem[],
  dragged: BoardItem,
  priorities: readonly string[],
  sort: ColumnSort,
): number {
  const ranked = [...items, dragged].sort(compareBy(sort, priorities));
  const index = ranked.findIndex((entry) => entry.id === dragged.id);
  return index === -1 ? items.length : index;
}

function BoardSkeleton() {
  return (
    <div data-testid="board-skeleton" aria-busy="true" aria-label="Loading board" className="flex w-full min-w-0 gap-4 overflow-x-scroll bg-background px-4">
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

const NO_EDITS: readonly Edit[] = [];
const NO_PEOPLE: Readonly<Record<string, InitiativePeople>> = {};

function ColumnSelect({
  label,
  testId,
  value,
  options,
  onChange,
}: {
  label: string;
  testId: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <select
      aria-label={label}
      title={label}
      data-testid={testId}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onPointerDown={(event) => event.stopPropagation()}
      className="h-6 max-w-[9.5rem] rounded-md border border-border bg-background px-1 text-xs text-foreground focus-visible:outline-2 focus-visible:outline-ring"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function statusHeading(status: string): string {
  const label = status.replaceAll("-", " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}
