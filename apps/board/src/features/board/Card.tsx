import { Check, Clock, FileText, GitBranch, GitPullRequest, Lock } from "lucide-react";
import type { BoardItem, Edit, InitiativePeople } from "snoboard/browser";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatAge } from "@/features/board/age";
import { formatPending } from "@/features/basket/store";
import { priorityLabel, type Proposal } from "@/features/board/model";
import { phaseProgress, priorityVariant, showsBranchBadge } from "@/features/board/model";
import { IssueCount } from "@/features/issues/IssueBadge";
import { readinessPending, type CommittedState } from "@/features/board/effective";
import { PeopleRow } from "@/features/people/People";

const blockedBadgeClass =
  "border-amber-600/50! bg-amber-500/10! text-amber-800! dark:border-amber-400/50! dark:bg-amber-400/10! dark:text-amber-200!";
const readyBadgeClass =
  "border-emerald-600/50! bg-emerald-500/10! text-emerald-800! dark:border-emerald-400/50! dark:bg-emerald-400/10! dark:text-emerald-200!";
const staleBadgeClass = "border-dashed! text-muted-foreground!";
const branchBadgeClass =
  "max-w-full min-w-0 border-transparent! bg-muted! text-muted-foreground!";
const pendingBadgeClass =
  "border-sky-600/50! bg-sky-500/10! text-sky-800! dark:border-sky-400/50! dark:bg-sky-400/10! dark:text-sky-200!";
const proposedBadgeClass =
  "border-violet-600/50! bg-violet-500/10! text-violet-800! dark:border-violet-400/50! dark:bg-violet-400/10! dark:text-violet-200!";

export function BoardCard({
  item,
  doneStatuses,
  defaultBranch,
  stale = false,
  pending = [],
  proposed = [],
  titles,
  people,
  onOpen,
}: {
  item: BoardItem & { committed?: CommittedState };
  people?: InitiativePeople;
  doneStatuses: readonly string[];
  defaultBranch: string | null;
  stale?: boolean;
  pending?: readonly Edit[];
  proposed?: readonly Proposal[];
  titles?: ReadonlyMap<string, string>;
  onOpen?: (id: string) => void;
}) {
  const progress = phaseProgress(item, doneStatuses);
  const variant = priorityVariant(item.priority);
  const blocked = item.blockedBy.length > 0;
  // Pending basket edits (e.g. a dependency moved to done) changed blocked/ready.
  const readyPending = readinessPending(item);
  const pendingSuffix = readyPending ? " (pending)" : "";
  const branch = showsBranchBadge(item.sourceRef, defaultBranch);
  const age = formatAge(item.updatedAt);

  return (
    <article
      tabIndex={0}
      data-testid={`card-${item.id}`}
      aria-label={`${item.id}: ${item.title}`}
      className="flex flex-col gap-2 rounded-lg bg-card p-3 text-card-foreground ring-1 ring-foreground/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono text-xs text-muted-foreground">{item.id}</p>
          <h3 className="text-sm font-medium leading-snug">
            <a
              href={`?open=${encodeURIComponent(item.id)}`}
              className="hover:underline"
              onClick={(event) => {
                if (onOpen === undefined) return;
                event.preventDefault();
                onOpen(item.id);
              }}
            >
              {item.title}
            </a>
          </h3>
        </div>
        <Badge variant={variant} data-priority={item.priority} title={`Priority ${priorityLabel(item.priority)} (p0 is most urgent)`}>
          {item.priority}
        </Badge>
      </div>
      <p className="flex justify-between gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate">{item.project}</span>
        {age !== null ? (
          <time dateTime={item.updatedAt} title={`Last change ${item.updatedAt}`} className="shrink-0">
            {age === "now" ? "changed just now" : `changed ${age} ago`}
          </time>
        ) : null}
      </p>
      {people !== undefined && people.participants.length > 0 ? <PeopleRow people={people} /> : null}
      {item.labels !== undefined && item.labels.length > 0 ? (
        <ul className="flex flex-wrap gap-1">
          {item.labels.map((label) => (
            <li key={label}>
              <Badge variant="secondary">{label}</Badge>
            </li>
          ))}
        </ul>
      ) : null}
      {progress !== null ? (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Phases</span>
            <span>
              {progress.done}/{progress.total}
            </span>
          </div>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.done}
            aria-label={`Phase progress ${progress.done}/${progress.total}`}
            className="h-1 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full bg-primary"
              style={{ width: `${progress.total === 0 ? 0 : (progress.done / progress.total) * 100}%` }}
            />
          </div>
        </div>
      ) : null}
      <div className="flex min-w-0 flex-wrap gap-1">
        <IssueCount issues={item.issues} />
        <ReportCount count={item.reports?.length ?? 0} />
        {blocked ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="inline-flex max-w-full rounded-4xl"
                  aria-label={`Blocked by ${item.blockedBy.join(", ")}${pendingSuffix}`}
                />
              }
            >
              <Badge variant="outline" className={blockedBadgeClass}>
                <Lock aria-hidden="true" data-icon="lock" />
                blocked{pendingSuffix}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>Blocked by {item.blockedBy.join(", ")}</TooltipContent>
          </Tooltip>
        ) : null}
        {!blocked && item.isReady ? (
          <Badge
            variant="outline"
            className={readyBadgeClass}
            data-testid="ready-badge"
            title={readyPending ? "Ready once the basket is submitted" : undefined}
          >
            <Check aria-hidden="true" data-icon="check" />
            ready{pendingSuffix}
          </Badge>
        ) : null}
        {stale ? (
          <Badge variant="outline" className={staleBadgeClass} title="No change for a long time: still relevant?">
            <Clock aria-hidden="true" data-icon="clock" />
            stale
          </Badge>
        ) : null}
        {branch ? (
          <Badge variant="outline" title={item.sourceRef} className={branchBadgeClass}>
            <GitBranch aria-hidden="true" data-icon="git-branch" />
            <span className="min-w-0 truncate">{item.sourceRef}</span>
          </Badge>
        ) : null}
        {pending.length > 0 ? (
          <Badge variant="outline" data-testid="pending-badge" className={pendingBadgeClass}>
            pending
          </Badge>
        ) : null}
        {pending.map((edit, index) => (
          <span key={`${edit.kind}:${index}`} data-testid="pending-value" className="text-xs text-muted-foreground">
            {formatPending(edit)}
          </span>
        ))}
        {proposed.length > 0 ? (
          <Badge variant="outline" data-testid="proposed-badge" className={proposedBadgeClass} title="Open edit, not merged yet">
            <GitPullRequest aria-hidden="true" data-icon="git-pull-request" />
            proposed
          </Badge>
        ) : null}
        {proposed.flatMap((proposal) =>
          proposal.fields.map((field) => {
            const text = `${field.field}: ${proposedValue(field.value, titles)}`;
            return (
              <span
                key={`${proposal.branch}:${field.field}`}
                data-testid="proposed-value"
                title={text}
                className="max-w-full min-w-0 truncate text-xs text-muted-foreground"
              >
                {text}
              </span>
            );
          }),
        )}
        {proposedPulls(proposed).map((pull) => (
          <a key={pull.number} href={pull.url} data-testid="proposed-pr" className="text-xs underline">
            PR #{pull.number}
          </a>
        ))}
      </div>
    </article>
  );
}

const INITIATIVE_REF = /^[a-z0-9_-]+-\d{3}(?:#(?:[1-9]\d*))?$/;

function proposedValue(value: string, titles: ReadonlyMap<string, string> | undefined): string {
  if (titles === undefined || titles.size === 0) return value;
  return value
    .split(", ")
    .map((part) => {
      if (!INITIATIVE_REF.test(part)) return part;
      const base = part.split("#")[0] ?? part;
      const title = titles.get(base);
      if (title === undefined || title.trim().length === 0) return part;
      return `${part} · ${title}`;
    })
    .join(", ");
}

/** Tiny "N reports" indicator; the list comes with the board payload, so no extra request. */
function ReportCount({ count }: { count: number }) {
  if (count === 0) return null;
  const label = count === 1 ? "1 report" : `${count} reports`;
  return (
    <Badge variant="outline" data-testid="report-count" title={label} className="gap-1 text-muted-foreground!">
      <FileText aria-hidden="true" className="size-3" />
      {label}
    </Badge>
  );
}

function proposedPulls(proposals: readonly Proposal[]): { number: number; url: string }[] {
  const pulls: { number: number; url: string }[] = [];
  for (const proposal of proposals) {
    if (proposal.pr === undefined) continue;
    if (pulls.some((pull) => pull.number === proposal.pr?.number)) continue;
    pulls.push(proposal.pr);
  }
  return pulls;
}
