import { Bot, Check, X } from "lucide-react";
import { useState } from "react";
import type { Edit } from "snoboard/browser";
import { Button } from "@/components/ui/button";
import { acceptProposal, pendingProposals, rejectProposal, useAgentBridge, type Proposal } from "./bridge";
import { ProposalEditRow, TextEditDiff } from "./Inbox";

function touches(edit: Edit, id: string): boolean {
  return "id" in edit && edit.id === id;
}

/** Pending proposals with an edit for initiative `id` (any repository branch of `repoId`). */
export function proposalsFor(proposals: readonly Proposal[], repoId: string, id: string): Proposal[] {
  return pendingProposals(proposals, repoId).filter((proposal) => proposal.edits.some((edit) => touches(edit, id)));
}

function useDecide() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = async (work: () => Promise<string | null>) => {
    setBusy(true);
    setError(await work());
    setBusy(false);
  };
  return { busy, error, decide };
}

/** In the details panel: what agents propose for this initiative, with diffs, as soon as it arrives. */
export function InitiativeProposals({ repoId, id }: { repoId: string; id: string }) {
  const { proposals } = useAgentBridge();
  const { busy, error, decide } = useDecide();
  const mine = proposalsFor(proposals, repoId, id);
  if (mine.length === 0) return null;
  return (
    <section
      className="flex flex-col gap-2 rounded-lg border border-sky-500/40 bg-sky-500/5 p-3"
      aria-label="Agent proposals"
      data-testid="initiative-proposals"
    >
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <Bot aria-hidden="true" className="size-4" />
        {mine.length === 1 ? "An agent proposes changes" : `${mine.length} agent proposals`}
      </h2>
      {error !== null ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {mine.map((proposal) => (
        <div key={proposal.id} className="flex flex-col gap-1 border-t border-border/60 pt-2 first:border-t-0 first:pt-0">
          <p className="text-xs text-muted-foreground">
            From {proposal.source} on {proposal.branch}
            {proposal.note.length > 0 ? ` — ${proposal.note}` : ""}
          </p>
          <ul className="flex flex-col gap-1">
            {proposal.edits
              .filter((edit) => touches(edit, id))
              .map((edit, index) => (
                <li key={index}>
                  <ProposalEditRow repo={proposal.repo} branch={proposal.branch} edit={edit} />
                </li>
              ))}
          </ul>
          {proposal.edits.some((edit) => !touches(edit, id)) ? (
            <p className="text-xs text-muted-foreground">
              It also changes other initiatives; see the inbox.
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button type="button" size="xs" disabled={busy} onClick={() => void decide(() => acceptProposal(proposal))}>
              <Check aria-hidden="true" />
              Accept
            </Button>
            <Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => void decide(() => rejectProposal(proposal))}>
              <X aria-hidden="true" />
              Reject
            </Button>
          </div>
        </div>
      ))}
    </section>
  );
}

/** In the document viewer: a proposed new version of the open document, with a diff toggle. */
export function DocProposals({ repoId, id, path }: { repoId: string; id: string; path: string }) {
  const { proposals } = useAgentBridge();
  const { busy, error, decide } = useDecide();
  const [shown, setShown] = useState<string | null>(null);
  const matches = pendingProposals(proposals, repoId).flatMap((proposal) =>
    proposal.edits
      .filter((edit) => (edit.kind === "setDoc" || edit.kind === "createDoc") && edit.id === id && edit.path === path)
      .map((edit) => ({ proposal, edit })),
  );
  if (matches.length === 0) return null;
  return (
    <div className="mb-3 flex flex-col gap-2 rounded-lg border border-sky-500/40 bg-sky-500/5 p-2 text-sm" data-testid="doc-proposals">
      {error !== null ? <p role="alert" className="text-destructive">{error}</p> : null}
      {matches.map(({ proposal, edit }) => (
        <div key={proposal.id} className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Bot aria-hidden="true" className="size-4" />
            <span className="min-w-0 flex-1">
              {proposal.source} proposes a new version{proposal.note.length > 0 ? `: ${proposal.note}` : ""}
            </span>
            <Button
              type="button"
              size="xs"
              variant="outline"
              aria-pressed={shown === proposal.id}
              data-testid="doc-proposal-toggle"
              onClick={() => setShown(shown === proposal.id ? null : proposal.id)}
            >
              {shown === proposal.id ? "Hide diff" : "Show diff"}
            </Button>
            <Button type="button" size="xs" disabled={busy} onClick={() => void decide(() => acceptProposal(proposal))}>
              Accept
            </Button>
            <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => void decide(() => rejectProposal(proposal))}>
              Reject
            </Button>
          </div>
          {shown === proposal.id ? <TextEditDiff repo={proposal.repo} branch={proposal.branch} edit={edit} /> : null}
        </div>
      ))}
    </div>
  );
}
