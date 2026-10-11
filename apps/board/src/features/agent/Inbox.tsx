import { Bot, Check, Inbox as InboxIcon, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { Edit } from "snoboard/browser";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { describeEdit } from "@/features/basket/store";
import { useBoardView } from "@/features/board/view-store";
import { collapseDiff, lineDiff } from "@/lib/line-diff";
import {
  acceptAllProposals,
  acceptProposal,
  pendingProposals,
  rejectProposal,
  useAgentBridge,
  type Proposal,
} from "./bridge";

/** Header button: "N proposals", opens the inbox. Hidden when the bridge is off for this person. */
export function InboxButton({ repoId }: { repoId: string | null }) {
  const { config, proposals } = useAgentBridge();
  const [open, setOpen] = useState(false);
  if (config === null || !config.enabled || !config.available) return null;
  const pending = pendingProposals(proposals);
  const label = pending.length === 1 ? "1 proposal" : `${pending.length} proposals`;
  return (
    <>
      <Button
        type="button"
        variant={pending.length > 0 ? "secondary" : "ghost"}
        size="sm"
        data-testid="inbox-button"
        aria-label={`Agent inbox: ${label}`}
        onClick={() => setOpen(true)}
      >
        <InboxIcon aria-hidden="true" />
        <span className="hidden sm:inline">{label}</span>
        <span className="sm:hidden">{pending.length}</span>
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full gap-0 sm:max-w-2xl!" data-testid="inbox-sheet">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <Bot aria-hidden="true" className="size-5" />
              Agent inbox
            </SheetTitle>
            <SheetDescription>
              Proposals from your coding agents. Accept puts the edits in your basket; nothing is committed until you submit.
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            <InboxPanel repoId={repoId} />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

export function InboxPanel({ repoId }: { repoId: string | null }) {
  const { proposals } = useAgentBridge();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = pendingProposals(proposals);
  const recent = proposals.filter((proposal) => proposal.status !== "pending").slice(0, 10);
  const run = async (work: () => Promise<string | null>) => {
    setBusy(true);
    setError(await work());
    setBusy(false);
  };
  return (
    <div className="flex flex-col gap-4" data-testid="inbox-panel">
      {error !== null ? (
        <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
          {error}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Pending ({pending.length})</h3>
        {pending.length > 1 ? (
          <Button type="button" size="sm" disabled={busy} onClick={() => void run(() => acceptAllProposals())} data-testid="inbox-accept-all">
            <Check aria-hidden="true" />
            Accept all
          </Button>
        ) : null}
      </div>
      {pending.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="inbox-empty">
          No pending proposals. Give your agent a prompt with “Copy prompt for agent” on an initiative, a phase or the basket.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {pending.map((proposal) => (
            <li key={proposal.id}>
              <ProposalCard
                proposal={proposal}
                otherRepo={repoId !== null && proposal.repo !== repoId}
                busy={busy}
                onAccept={() => void run(() => acceptProposal(proposal))}
                onReject={() => void run(() => rejectProposal(proposal))}
              />
            </li>
          ))}
        </ul>
      )}
      {recent.length > 0 ? (
        <section className="flex flex-col gap-1">
          <h3 className="text-sm font-medium text-muted-foreground">Recently decided</h3>
          <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
            {recent.map((proposal) => (
              <li key={proposal.id} data-testid="inbox-decided">
                {proposal.status === "accepted" ? "Accepted" : "Rejected"} · {proposal.repo}@{proposal.branch} · {proposal.edits.length}{" "}
                {proposal.edits.length === 1 ? "edit" : "edits"} from {proposal.source}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

export function ProposalCard({
  proposal,
  otherRepo = false,
  busy = false,
  onAccept,
  onReject,
  defaultExpanded = false,
}: {
  proposal: Proposal;
  otherRepo?: boolean;
  busy?: boolean;
  onAccept: () => void;
  onReject: () => void;
  defaultExpanded?: boolean;
}) {
  return (
    <article className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 text-card-foreground" data-testid="proposal-card">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">
          {proposal.edits.length} {proposal.edits.length === 1 ? "edit" : "edits"} from {proposal.source}
        </p>
        <p className="font-mono text-xs text-muted-foreground">
          {otherRepo ? `${proposal.repo} · ` : ""}
          {proposal.branch} · {formatTime(proposal.created)}
        </p>
      </header>
      {proposal.note.length > 0 ? <p className="whitespace-pre-wrap text-sm text-muted-foreground">{proposal.note}</p> : null}
      <ul className="flex flex-col gap-1">
        {proposal.edits.map((edit, index) => (
          <li key={index}>
            <ProposalEditRow repo={proposal.repo} branch={proposal.branch} edit={edit} defaultExpanded={defaultExpanded} />
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={busy} onClick={onAccept} aria-label={`Accept proposal ${proposal.id}`}>
          <Check aria-hidden="true" />
          Accept
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onReject} aria-label={`Reject proposal ${proposal.id}`}>
          <X aria-hidden="true" />
          Reject
        </Button>
      </div>
    </article>
  );
}

function hasText(edit: Edit): boolean {
  return edit.kind === "setBody" || edit.kind === "setDoc" || edit.kind === "createDoc" || edit.kind === "createInitiative";
}

export function ProposalEditRow({
  repo,
  branch,
  edit,
  defaultExpanded = false,
}: {
  repo: string;
  branch: string;
  edit: Edit;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const view = useBoardView();
  const text = hasText(edit);
  const title = "id" in edit ? view?.items.get(edit.id)?.title : undefined;
  const titles = title === undefined || !("id" in edit) ? undefined : new Map([[edit.id, title]]);
  return (
    <div className="flex flex-col gap-1 text-sm">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="min-w-0 truncate" data-testid="proposal-edit">
          {describeEdit(edit, titles)}
        </span>
        {text ? (
          <Button type="button" size="xs" variant="ghost" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            {expanded ? "Hide diff" : "Show diff"}
          </Button>
        ) : null}
      </div>
      {text && expanded ? <TextEditDiff repo={repo} branch={branch} edit={edit} /> : null}
    </div>
  );
}

/** Committed text of what a text edit changes ("" for something new), from the board's own endpoints. */
export async function committedTextFor(repo: string, branch: string, edit: Edit, signal?: AbortSignal): Promise<string | null> {
  if (edit.kind === "createDoc" || edit.kind === "createInitiative") return "";
  if (edit.kind !== "setBody" && edit.kind !== "setDoc") return null;
  const base = `/api/repos/${encodeURIComponent(repo)}/initiatives/${encodeURIComponent(edit.id)}`;
  const path =
    edit.kind === "setBody" ? `${base}/body` : `${base}/doc-source/${edit.path.split("/").map(encodeURIComponent).join("/")}`;
  // The branch alone first; the default branch's basket also covers initiatives only on other branches (merged view).
  for (const url of [`${path}?ref=${encodeURIComponent(branch)}`, path]) {
    try {
      const response = await fetch(url, { credentials: "same-origin", signal: signal ?? null });
      if (!response.ok) continue;
      const body: unknown = await response.json();
      if (typeof body !== "object" || body === null) continue;
      const value = edit.kind === "setBody" ? (body as { body?: unknown }).body : (body as { text?: unknown }).text;
      if (typeof value === "string") return value;
    } catch {
      return null;
    }
  }
  return null;
}

function proposedText(edit: Edit): string {
  switch (edit.kind) {
    case "setBody":
    case "setDoc":
    case "createDoc":
      return edit.to;
    case "createInitiative":
      return edit.body ?? "";
    default:
      return "";
  }
}

export function TextEditDiff({ repo, branch, edit }: { repo: string; branch: string; edit: Edit }) {
  const [before, setBefore] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    void committedTextFor(repo, branch, edit, controller.signal).then((text) => {
      if (!controller.signal.aborted) setBefore(text);
    });
    return () => controller.abort();
  }, [repo, branch, edit]);
  if (before === undefined) return <p className="text-xs text-muted-foreground">Loading diff…</p>;
  if (before === null) {
    return (
      <div className="flex flex-col gap-1">
        <p className="text-xs text-muted-foreground">The committed version could not be loaded; this is the proposed text.</p>
        <DiffView before="" after={proposedText(edit)} />
      </div>
    );
  }
  return <DiffView before={before} after={proposedText(edit)} />;
}

export function DiffView({ before, after }: { before: string; after: string }) {
  const lines = collapseDiff(lineDiff(before, after));
  const changed = lines.some((line) => line.type === "add" || line.type === "del");
  if (!changed) return <p className="text-xs text-muted-foreground">No text changes.</p>;
  return (
    <pre className="max-h-96 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-xs leading-5" data-testid="diff-view">
      {lines.map((line, index) =>
        line.type === "skip" ? (
          <div key={index} className="text-muted-foreground">
            ⋯ {line.count} unchanged {line.count === 1 ? "line" : "lines"}
          </div>
        ) : (
          <div
            key={index}
            data-diff={line.type}
            className={
              line.type === "add"
                ? "bg-emerald-500/15 text-emerald-900 dark:text-emerald-200"
                : line.type === "del"
                  ? "bg-rose-500/15 text-rose-900 line-through decoration-rose-500/40 dark:text-rose-200"
                  : ""
            }
          >
            <span aria-hidden="true" className="inline-block w-4 select-none text-muted-foreground">
              {line.type === "add" ? "+" : line.type === "del" ? "-" : " "}
            </span>
            {line.text.length === 0 ? " " : line.text}
          </div>
        ),
      )}
    </pre>
  );
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().slice(0, 16).replace("T", " ");
}
