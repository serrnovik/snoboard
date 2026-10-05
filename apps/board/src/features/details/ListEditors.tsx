import { Plus, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import {
  issueLinkFor,
  issueRefFromUrl,
  linkProblem,
  MAX_ISSUE_REFS,
  MAX_LINKS,
  normalizeIssueRef,
  parseIssueRef,
  type Edit,
  type IssueLinkConfig,
} from "snoboard/browser";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useBasket } from "@/features/basket/store";
import { IssueBadge, normalizeIssues, type IssueView } from "@/features/issues/IssueBadge";
import { NewIssueDialog, type CreateProviderId } from "@/features/issues/NewIssueDialog";
import { useRepoId } from "@/features/repo/context";

type Link = { title: string; url: string };

/**
 * The ref to store for typed or pasted `text`: tracker URLs become short refs
 * (`gh#12`, `gh:owner/name#12`, `fj#12`, `fj:owner/name#12`, `vj:45`) and `vikunja:45` becomes `vj:45`.
 */
export function issueRefInput(text: string, config: IssueLinkConfig = {}): { ref: string } | { error: string } {
  const fromUrl = issueRefFromUrl(text, config);
  if (fromUrl !== undefined) return fromUrl;
  return { ref: normalizeIssueRef(text) };
}

/** Why `text` cannot be added to `current`, or undefined. Empty input is not an error yet. */
export function issueRefProblem(text: string, current: readonly string[], config: IssueLinkConfig = {}): string | undefined {
  if (text.trim().length === 0) return undefined;
  const input = issueRefInput(text, config);
  if ("error" in input) return input.error;
  const ref = input.ref;
  if (parseIssueRef(ref) === undefined) return "Use gh#12, gh:owner/name#12, fj#12, fj:owner/name#12, vj:45, a tracker URL or provider:key.";
  if (current.some((entry) => normalizeIssueRef(entry) === ref)) return `${ref} is already listed.`;
  if (current.length >= MAX_ISSUE_REFS) return `At most ${MAX_ISSUE_REFS} issue refs.`;
  return undefined;
}

export function IssuesEditor({
  id,
  issues,
  linkConfig = {},
  create,
}: {
  id: string;
  issues: unknown;
  linkConfig?: IssueLinkConfig;
  /** "New issue": trackers this person may create in, plus what prefills the dialog. */
  create?: { providers: readonly CreateProviderId[]; csrf: string | undefined; title: string; summary: string };
}) {
  const repoId = useRepoId();
  const basket = useBasket(repoId);
  // Issues created in this panel: their link is known before the next board refresh.
  const [created, setCreated] = useState<{ ref: string; url: string }[]>([]);
  const [notice, setNotice] = useState<{ ref: string; url: string } | null>(null);
  const inputId = useId();
  const views = normalizeIssues(issues);
  const original = views.map((view) => view.raw);
  const pending = basket.edits.find(
    (edit): edit is Extract<Edit, { kind: "setIssues" }> => edit.kind === "setIssues" && edit.id === id,
  );
  const shown = pending?.to ?? original;
  const [draft, setDraft] = useState("");
  const problem = issueRefProblem(draft, shown, linkConfig);

  function save(next: string[]) {
    basket.add({ kind: "setIssues", id, from: original, to: next });
  }

  function add() {
    if (draft.trim().length === 0 || problem !== undefined) return;
    const input = issueRefInput(draft, linkConfig);
    if ("error" in input) return;
    save([...shown, input.ref]);
    setDraft("");
  }

  return (
    <div role="group" aria-labelledby={`${inputId}-label`} data-testid="issues-editor" className="flex flex-col gap-1 text-sm">
      <span id={`${inputId}-label`}>Issues</span>
      {shown.length > 0 ? (
        <ul className="flex flex-col gap-1" aria-label="Issue refs">
          {shown.map((raw) => (
            <li key={raw} data-testid="issue-chip" className="flex min-w-0 items-center justify-between gap-2 rounded-md border px-2 py-1">
              <IssueBadge issue={withLink(views.find((view) => view.raw === raw) ?? createdIssue(raw, created), linkConfig)} />
              <button
                type="button"
                aria-label={`Remove ${raw}`}
                className="shrink-0 text-muted-foreground hover:text-foreground"
                onClick={() => save(shown.filter((entry) => entry !== raw))}
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No issues.</p>
      )}
      <div className="flex gap-2">
        <Input
          id={inputId}
          aria-label="Add issue ref"
          placeholder="gh#12, fj#12, vj:45 or paste an issue URL"
          value={draft}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={problem !== undefined}
          aria-describedby={problem !== undefined ? `${inputId}-error` : undefined}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            add();
          }}
        />
        <Button type="button" variant="outline" disabled={draft.trim().length === 0 || problem !== undefined} onClick={add}>
          Add
        </Button>
      </div>
      {problem !== undefined ? (
        <p id={`${inputId}-error`} role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      ) : null}
      {create !== undefined && create.providers.length > 0 ? (
        <NewIssueDialog
          repoId={repoId}
          initiative={{ id, title: create.title, summary: create.summary }}
          providers={create.providers}
          csrf={create.csrf}
          onCreated={(issue) => {
            setCreated((current) => [...current.filter((entry) => entry.ref !== issue.ref), issue]);
            if (!shown.includes(issue.ref)) save([...shown, issue.ref]);
            setNotice(issue);
          }}
        />
      ) : null}
      {notice !== null ? (
        <p role="status" data-testid="issue-created" className="text-xs text-muted-foreground">
          Created{" "}
          {notice.url.length > 0 ? (
            <a href={notice.url} target="_blank" rel="noopener noreferrer" className="underline">
              {notice.ref}
            </a>
          ) : (
            notice.ref
          )}
          . Added to the basket; submit to link it.
        </p>
      ) : null}
    </div>
  );
}

function createdIssue(raw: string, created: readonly { ref: string; url: string }[]): IssueView {
  const match = created.find((entry) => entry.ref === raw);
  return match === undefined ? unknownIssue(raw) : { raw, url: match.url, title: "", state: "open" };
}

function unknownIssue(raw: string): IssueView {
  return { raw, url: "", title: "", state: "unknown" };
}

/** Chips link even when the server could not read the state (no token, new ref). */
function withLink(view: IssueView, config: IssueLinkConfig): IssueView {
  if (view.url.length > 0) return view;
  const url = issueLinkFor(view.raw, config);
  return url.length > 0 ? { ...view, url } : view;
}

export function readLinks(value: unknown): Link[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): Link[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const record = entry as Record<string, unknown>;
    return typeof record.title === "string" && typeof record.url === "string"
      ? [{ title: record.title, url: record.url }]
      : [];
  });
}

export function LinksEditor({ id, links }: { id: string; links: unknown }) {
  const basket = useBasket(useRepoId());
  const formId = useId();
  const original = readLinks(links);
  const pending = basket.edits.find(
    (edit): edit is Extract<Edit, { kind: "setLinks" }> => edit.kind === "setLinks" && edit.id === id,
  );
  const shown = pending?.to ?? original;
  const shownKey = JSON.stringify(shown);
  const [rows, setRows] = useState<Link[]>(shown);
  const [errors, setErrors] = useState<(string | undefined)[]>([]);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setRows(JSON.parse(shownKey) as Link[]);
    setErrors([]);
  }, [shownKey]);

  function update(index: number, patch: Partial<Link>) {
    setSaved(false);
    setRows((current) => current.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)));
  }

  function save() {
    const trimmed = rows.map((row) => ({ title: row.title.trim(), url: row.url.trim() }));
    const problems = trimmed.map((row) => linkProblem(row));
    setErrors(problems);
    if (problems.some((problem) => problem !== undefined)) return;
    basket.add({ kind: "setLinks", id, from: original, to: trimmed });
    setSaved(true);
  }

  return (
    <fieldset data-testid="links-editor" className="flex flex-col gap-2 text-sm">
      <legend className="text-sm">Links</legend>
      {rows.length === 0 ? <p className="text-xs text-muted-foreground">No links.</p> : null}
      {rows.map((row, index) => (
        <div key={index} data-testid="link-row" className="flex flex-col gap-1">
          <div className="flex gap-2">
            <Input
              aria-label={`Link ${index + 1} title`}
              placeholder="Title"
              value={row.title}
              maxLength={120}
              aria-invalid={errors[index] !== undefined}
              onChange={(event) => update(index, { title: event.target.value })}
            />
            <Input
              aria-label={`Link ${index + 1} URL`}
              placeholder="https://…"
              value={row.url}
              inputMode="url"
              spellCheck={false}
              aria-invalid={errors[index] !== undefined}
              onChange={(event) => update(index, { url: event.target.value })}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Remove link ${index + 1}`}
              onClick={() => {
                setSaved(false);
                setRows((current) => current.filter((_, rowIndex) => rowIndex !== index));
                setErrors((current) => current.filter((_, rowIndex) => rowIndex !== index));
              }}
            >
              <X className="size-3.5" aria-hidden="true" />
            </Button>
          </div>
          {errors[index] !== undefined ? (
            <p role="alert" className="text-xs text-destructive">
              Link {index + 1}: {errors[index]}
            </p>
          ) : null}
        </div>
      ))}
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={rows.length >= MAX_LINKS}
          onClick={() => {
            setSaved(false);
            setRows((current) => [...current, { title: "", url: "" }]);
          }}
        >
          <Plus className="size-3.5" aria-hidden="true" />
          Add link
        </Button>
        <Button type="button" size="sm" id={`${formId}-save`} onClick={save}>
          Save links
        </Button>
        {saved ? <span className="self-center text-xs text-muted-foreground">Added to basket.</span> : null}
      </div>
    </fieldset>
  );
}
