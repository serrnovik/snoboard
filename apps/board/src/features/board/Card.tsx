import { Check, GitBranch, Lock } from "lucide-react";
import type { BoardItem } from "snoboard/browser";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { phaseProgress, priorityVariant, showsBranchBadge } from "@/features/board/model";

const blockedBadgeClass =
  "border-amber-600/50! bg-amber-500/10! text-amber-800! dark:border-amber-400/50! dark:bg-amber-400/10! dark:text-amber-200!";
const readyBadgeClass =
  "border-emerald-600/50! bg-emerald-500/10! text-emerald-800! dark:border-emerald-400/50! dark:bg-emerald-400/10! dark:text-emerald-200!";
const branchBadgeClass =
  "max-w-full min-w-0 border-transparent! bg-muted! text-muted-foreground!";

export function BoardCard({
  item,
  doneStatuses,
  defaultBranch,
  onOpen,
}: {
  item: BoardItem;
  doneStatuses: readonly string[];
  defaultBranch: string | null;
  onOpen?: (id: string) => void;
}) {
  const progress = phaseProgress(item, doneStatuses);
  const variant = priorityVariant(item.priority);
  const blocked = item.blockedBy.length > 0;
  const branch = showsBranchBadge(item.sourceRef, defaultBranch);

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
        <Badge variant={variant} data-priority={item.priority}>
          {item.priority}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground">{item.project}</p>
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
        {blocked ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="inline-flex max-w-full rounded-4xl"
                  aria-label={`Blocked by ${item.blockedBy.join(", ")}`}
                />
              }
            >
              <Badge variant="outline" className={blockedBadgeClass}>
                <Lock aria-hidden="true" data-icon="lock" />
                blocked
              </Badge>
            </TooltipTrigger>
            <TooltipContent>Blocked by {item.blockedBy.join(", ")}</TooltipContent>
          </Tooltip>
        ) : null}
        {!blocked && item.isReady ? (
          <Badge variant="outline" className={readyBadgeClass}>
            <Check aria-hidden="true" data-icon="check" />
            ready
          </Badge>
        ) : null}
        {branch ? (
          <Badge variant="outline" title={item.sourceRef} className={branchBadgeClass}>
            <GitBranch aria-hidden="true" data-icon="git-branch" />
            <span className="min-w-0 truncate">{item.sourceRef}</span>
          </Badge>
        ) : null}
      </div>
    </article>
  );
}
