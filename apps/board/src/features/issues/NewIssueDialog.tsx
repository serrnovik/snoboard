import { useEffect, useId, useRef, useState } from "react";
import { MarkdownEditor } from "@/components/markdown-editor";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { githubWriteHref, submitNavigation } from "@/features/basket/SubmitDialog";
import { shareUrl } from "@/lib/ids";
import { repoApi } from "@/lib/routes";

export type CreateProviderId = "gh" | "fj" | "vikunja";

export const ISSUE_TITLE_MAX = 256;
export const ISSUE_BODY_MAX = 20_000;
export const ISSUE_RESUME_KEY = "snoboard:issue-resume:v1";
export const ISSUE_RESUME_PARAM = "resumeIssue";
const RESUME_MAX_AGE_MS = 10 * 60 * 1000;

const PROVIDER_NAMES: Record<CreateProviderId, string> = {
  gh: "GitHub (as you)",
  fj: "Forgejo",
  vikunja: "Vikunja",
};

export type IssueDraft = { provider: CreateProviderId; title: string; body: string; projectId?: number };

export type VikunjaProjects = { projects: { id: number; title: string }[]; selected?: number };

export function parseVikunjaProjects(value: unknown): VikunjaProjects {
  if (!isRecord(value) || !Array.isArray(value.projects)) return { projects: [] };
  const projects = value.projects.flatMap((entry) =>
    isRecord(entry) && typeof entry.id === "number" && Number.isInteger(entry.id) && entry.id > 0 && typeof entry.title === "string"
      ? [{ id: entry.id, title: entry.title }]
      : [],
  );
  const selected = typeof value.selected === "number" && projects.some((project) => project.id === value.selected) ? value.selected : undefined;
  return { projects, ...(selected === undefined ? {} : { selected }) };
}

type ResumeDraft = IssueDraft & { repoId: string; initiativeId: string; at: number };

export function defaultIssueTitle(initiativeTitle: string): string {
  return `${initiativeTitle}: `;
}

export function defaultIssueBody(link: string, summary: string): string {
  const intro = `Initiative on the board: ${link}`;
  const text = summary.trim();
  return text.length === 0 ? `${intro}\n` : `${intro}\n\n${text}\n`;
}

/** Why the draft cannot be sent, or undefined. Mirrors the server limits. */
export function issueDraftProblem(draft: Pick<IssueDraft, "title" | "body">): string | undefined {
  const title = draft.title.trim();
  if (title.length === 0) return "Title is required.";
  if ([...title].length > ISSUE_TITLE_MAX) return `Title is longer than ${ISSUE_TITLE_MAX} characters.`;
  if (/[\r\n]/.test(title)) return "Title must be one line.";
  if ([...draft.body].length > ISSUE_BODY_MAX) return `Text is longer than ${ISSUE_BODY_MAX} characters.`;
  return undefined;
}

function saveResume(draft: ResumeDraft): void {
  if (typeof sessionStorage === "undefined") return;
  sessionStorage.setItem(ISSUE_RESUME_KEY, JSON.stringify(draft));
}

/** Read and forget the draft saved before connecting GitHub, for this initiative only. */
export function takeIssueResume(repoId: string, initiativeId: string, now = Date.now()): IssueDraft | null {
  if (typeof sessionStorage === "undefined") return null;
  const raw = sessionStorage.getItem(ISSUE_RESUME_KEY);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    sessionStorage.removeItem(ISSUE_RESUME_KEY);
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record.repoId !== repoId || record.initiativeId !== initiativeId) return null;
  sessionStorage.removeItem(ISSUE_RESUME_KEY);
  const { provider, title, body, at, projectId } = record;
  if (provider !== "gh" && provider !== "fj" && provider !== "vikunja") return null;
  if (typeof title !== "string" || typeof body !== "string" || typeof at !== "number") return null;
  if (now - at > RESUME_MAX_AGE_MS || at > now + 60_000) return null;
  return { provider, title, body, ...(typeof projectId === "number" ? { projectId } : {}) };
}

function resumePath(location: Pick<Location, "pathname" | "search" | "hash">): string {
  const params = new URLSearchParams(location.search);
  params.set(ISSUE_RESUME_PARAM, "1");
  return `${location.pathname}?${params.toString()}${location.hash}`;
}

function clearResumeParam(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(ISSUE_RESUME_PARAM)) return;
  url.searchParams.delete(ISSUE_RESUME_PARAM);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
  } catch {
    return "";
  }
}

/** "New issue" button and dialog. Creates the issue on the server, then hands its ref to `onCreated`. */
export function NewIssueDialog({
  repoId,
  initiative,
  providers,
  csrf,
  onCreated,
}: {
  repoId: string;
  initiative: { id: string; title: string; summary: string };
  providers: readonly CreateProviderId[];
  csrf: string | undefined;
  onCreated: (created: { ref: string; url: string }) => void;
}) {
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<CreateProviderId>(providers[0] ?? "gh");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingResume, setPendingResume] = useState<IssueDraft | null>(null);
  const [vikunja, setVikunja] = useState<VikunjaProjects | null>(null);
  const [projectId, setProjectId] = useState<number | undefined>(undefined);
  const resumeChecked = useRef(false);
  const providerKey = providers.join(",");

  function start() {
    setProvider(providers[0] ?? "gh");
    setTitle(defaultIssueTitle(initiative.title));
    const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
    setBody(defaultIssueBody(shareUrl(origin, repoId, initiative.id), initiative.summary));
    setError(null);
    setOpen(true);
  }

  // Back from connecting GitHub: reopen the same draft and create it once.
  useEffect(() => {
    if (typeof window === "undefined" || resumeChecked.current || providerKey.length === 0) return;
    resumeChecked.current = true;
    if (new URLSearchParams(window.location.search).get(ISSUE_RESUME_PARAM) !== "1") return;
    const draft = takeIssueResume(repoId, initiative.id);
    clearResumeParam();
    if (draft === null || !providerKey.split(",").includes(draft.provider)) return;
    setProvider(draft.provider);
    setTitle(draft.title);
    setBody(draft.body);
    if (draft.projectId !== undefined) setProjectId(draft.projectId);
    setOpen(true);
    setPendingResume(draft);
  }, [repoId, initiative.id, providerKey]);

  useEffect(() => {
    if (pendingResume === null || csrf === undefined) return;
    setPendingResume(null);
    void create(pendingResume, false);
    // `create` reads the latest props; this runs once per resumed draft.
  }, [pendingResume, csrf]);

  const needsProjects = open && provider === "vikunja" && vikunja === null;
  useEffect(() => {
    if (!needsProjects) return;
    const controller = new AbortController();
    void fetch(repoApi(repoId, `/issues/vikunja-projects?initiative=${encodeURIComponent(initiative.id)}`), {
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => (response.ok ? parseVikunjaProjects(await response.json()) : { projects: [] }))
      .catch(() => ({ projects: [] }))
      .then((loaded: VikunjaProjects) => {
        if (controller.signal.aborted) return;
        setVikunja(loaded);
        setProjectId((current) => current ?? loaded.selected ?? loaded.projects[0]?.id);
      });
    return () => controller.abort();
  }, [needsProjects, repoId, initiative.id]);

  async function create(draft: IssueDraft, mayConnect: boolean) {
    const problem = issueDraftProblem(draft);
    if (problem !== undefined) {
      setError(problem);
      return;
    }
    if (csrf === undefined) {
      setError("Reload the board and try again.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(repoApi(repoId, "/issues/create"), {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: draft.provider,
          initiativeId: initiative.id,
          title: draft.title.trim(),
          body: draft.body,
          csrf,
          ...(draft.provider === "vikunja" && draft.projectId !== undefined ? { projectId: draft.projectId } : {}),
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (response.ok && isRecord(payload) && typeof payload.ref === "string" && typeof payload.url === "string") {
        onCreated({ ref: payload.ref, url: safeUrl(payload.url) });
        setOpen(false);
        return;
      }
      if (isRecord(payload) && payload.needsGithubWrite === true) {
        if (mayConnect && draft.provider === "gh") {
          saveResume({ ...draft, repoId, initiativeId: initiative.id, at: Date.now() });
          submitNavigation.assign(githubWriteHref(repoId, resumePath(window.location)));
          return;
        }
        setError("Connect GitHub write access, then try again.");
        return;
      }
      setError(
        isRecord(payload) && typeof payload.error === "string"
          ? payload.error
          : `Could not create the issue (${response.status}).`,
      );
    } catch {
      setError("Could not reach the board.");
    } finally {
      setBusy(false);
    }
  }

  if (providers.length === 0) return null;

  return (
    <>
      <div>
        <Button type="button" variant="outline" size="sm" onClick={start}>
          New issue
        </Button>
      </div>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next);
        }}
      >
        <DialogContent className="sm:max-w-2xl" data-testid="new-issue-dialog">
          <DialogHeader>
            <DialogTitle>New issue</DialogTitle>
            <DialogDescription>
              Created in the tracker right away. The link is added to this initiative with your next submit.
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void create({ provider, title, body, ...(projectId === undefined ? {} : { projectId }) }, true);
            }}
          >
            <label className="flex flex-col gap-1 text-sm" htmlFor={`${formId}-provider`}>
              Tracker
              <select
                id={`${formId}-provider`}
                className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
                value={provider}
                onChange={(event) => setProvider(event.target.value as CreateProviderId)}
              >
                {providers.map((entry) => (
                  <option key={entry} value={entry}>
                    {PROVIDER_NAMES[entry]}
                  </option>
                ))}
              </select>
            </label>
            {provider === "vikunja" ? (
              <label className="flex flex-col gap-1 text-sm" htmlFor={`${formId}-project`}>
                Vikunja project
                <select
                  id={`${formId}-project`}
                  className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
                  value={projectId === undefined ? "" : String(projectId)}
                  disabled={vikunja === null}
                  onChange={(event) => setProjectId(Number(event.target.value))}
                >
                  {vikunja === null ? <option value="">Loading…</option> : null}
                  {(vikunja?.projects ?? []).map((project) => (
                    <option key={project.id} value={String(project.id)}>
                      {project.title}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className="flex flex-col gap-1 text-sm" htmlFor={`${formId}-title`}>
              Title
              <Input
                id={`${formId}-title`}
                value={title}
                maxLength={ISSUE_TITLE_MAX}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <div className="flex flex-col gap-1 text-sm">
              <span>Description</span>
              <MarkdownEditor aria-label="Issue description" value={body} onChange={setBody} minHeight={200} />
            </div>
            {error !== null ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <DialogClose render={<Button type="button" variant="outline" disabled={busy} />}>Cancel</DialogClose>
              <Button type="submit" disabled={busy}>
                {busy ? "Creating…" : "Create"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
