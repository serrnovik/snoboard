import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { parseEditConfig, type ClientEditConfig, type EditModeName } from "@/features/basket/edit-config";
import { EditLabel } from "@/features/basket/EditLabel";
import { DEFAULT_REPO_ID, useBasket } from "@/features/basket/store";
import type { Edit } from "snoboard/browser";
import { repoApi } from "@/lib/routes";
import { getImage } from "@/features/attachments/store";

type ValidateResult = {
  index: number;
  ok: boolean;
  error?: string;
};

type SubmitSuccess = {
  ok: true;
  mode: EditModeName;
  commit: string;
  branch: string;
  pr?: { number: number; url: string };
  commitUrl?: string;
  created?: CreatedInitiative[];
};

type CreatedInitiative = { index: number; id?: string; number?: string; path: string };

type SubmitFailure = {
  ok: false;
  code: string;
  error: string;
  alternativeMode?: "pr";
};

/** `{ sha256: base64 }` for every image in the basket, read from IndexedDB. */
export async function attachmentPayload(
  edits: readonly Edit[],
): Promise<{ map: Record<string, string> } | { error: string }> {
  const map: Record<string, string> = {};
  for (const edit of edits) {
    if (edit.kind !== "addAttachment") continue;
    const stored = edit.key === undefined ? undefined : await getImage(edit.key).catch(() => undefined);
    if (stored === undefined) {
      return { error: `The image ${edit.path} is no longer stored in this browser. Remove it from the basket.` };
    }
    map[edit.sha256] = toBase64(stored.bytes);
  }
  return { map };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let start = 0; start < bytes.length; start += chunk) {
    binary += String.fromCharCode(...bytes.subarray(start, start + chunk));
  }
  return btoa(binary);
}

export function submitModeStorageKey(repoId: string): string {
  return `snoboard:submit-mode:v1:${repoId}`;
}

export function rememberedSubmitMode(
  repoId: string,
  modes: readonly EditModeName[],
  defaultMode: EditModeName,
): EditModeName {
  const stored = readStoredMode(repoId);
  if (stored !== undefined && modes.includes(stored)) return stored;
  if (modes.includes(defaultMode)) return defaultMode;
  return modes[0] ?? defaultMode;
}

export function rememberSubmitMode(repoId: string, mode: EditModeName): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(submitModeStorageKey(repoId), mode);
}

export function formatSubmitMode(mode: EditModeName, directBranch?: string): string {
  if (mode === "pr") return "Open a pull request";
  const branch = directBranch === undefined || directBranch.length === 0 ? "main" : directBranch;
  return branch === "main" ? "Push to main" : `Push to ${branch}`;
}

export function SubmitDialog({
  repoId = DEFAULT_REPO_ID,
  titles,
}: {
  repoId?: string;
  titles?: ReadonlyMap<string, string>;
}) {
  const basket = useBasket(repoId);
  const [open, setOpen] = useState(false);
  const modeGroup = useId();
  const [config, setConfig] = useState<ClientEditConfig | null>(null);
  const [mode, setMode] = useState<EditModeName>("direct");
  const [results, setResults] = useState<ValidateResult[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<SubmitFailure | null>(null);
  const [success, setSuccess] = useState<SubmitSuccess | null>(null);
  // The basket is cleared on success; keep what was sent so the result can list it.
  const [submitted, setSubmitted] = useState<readonly Edit[]>([]);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const edits = basket.list();
    setChecking(true);
    setResults(null);
    setFailure(null);
    setSuccess(null);
    setProblem(null);
    void Promise.all([
      fetch(repoApi(repoId, "/edit-config"), { credentials: "same-origin", signal: controller.signal }),
      fetch(repoApi(repoId, "/edits/validate"), {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ edits }),
        signal: controller.signal,
      }),
    ])
      .then(async ([configResponse, validateResponse]) => {
        if (controller.signal.aborted) return;
        const configBody: unknown = await configResponse.json().catch(() => null);
        const nextConfig = parseEditConfig(configBody);
        setConfig(nextConfig);
        setMode(rememberedSubmitMode(repoId, nextConfig.modes, nextConfig.defaultMode));
        if (!validateResponse.ok) {
          const validateBody: unknown = await validateResponse.json().catch(() => null);
          setProblem(messageOf(validateBody) ?? "Could not check the basket.");
          setResults(null);
          return;
        }
        const validateBody: unknown = await validateResponse.json().catch(() => null);
        setResults(parseResults(validateBody));
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setProblem("Could not check the basket.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setChecking(false);
      });
    return () => controller.abort();
  }, [open, repoId, basket.list]);

  function chooseMode(next: EditModeName) {
    setMode(next);
    rememberSubmitMode(repoId, next);
  }

  async function send(nextMode: EditModeName) {
    const current = config;
    if (current?.csrf === undefined) {
      setProblem("Reload the board and try again.");
      return;
    }
    setBusy(true);
    setProblem(null);
    const sent = basket.list();
    try {
      const attachments = await attachmentPayload(sent);
      if ("error" in attachments) {
        setProblem(attachments.error);
        return;
      }
      const response = await fetch(repoApi(repoId, "/edits/submit"), {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          edits: sent,
          mode: nextMode,
          csrf: current.csrf,
          repo: repoId,
          ...(Object.keys(attachments.map).length === 0 ? {} : { attachments: attachments.map }),
        }),
      });
      if (response.status === 413) {
        const tooLarge: unknown = await response.json().catch(() => null);
        setFailure({
          ok: false,
          code: "too_large",
          error: messageOf(tooLarge) ?? "The submit is too large. Remove some images and try again.",
        });
        return;
      }
      const body: unknown = await response.json().catch(() => null);
      const parsed = parseSubmit(body);
      if (parsed === null) {
        setFailure({ ok: false, code: "invalid", error: "The submit did not return a result." });
        return;
      }
      if (parsed.ok) {
        setSubmitted(sent);
        basket.clear();
        setFailure(null);
        setSuccess(parsed);
        return;
      }
      if (parsed.code === "needs_github_write") {
        setConfig({ ...current, needsGithubWrite: true });
      }
      setFailure(parsed);
    } catch {
      setProblem("Could not submit the basket.");
    } finally {
      setBusy(false);
    }
  }

  const edits = basket.list();
  const valid = results !== null && results.length > 0 && results.every((result) => result.ok);
  const needsGithubWrite = config?.needsGithubWrite === true;
  const offerPr =
    failure !== null &&
    (config?.modes.includes("pr") ?? false) &&
    (failure.alternativeMode === "pr" || failure.code === "direct_rejected" || failure.code === "branch_moved");

  // Nothing to submit and nothing to report: no trigger. Once open, the dialog
  // stays mounted after a successful submit clears the basket, so the result shows.
  if (!open && edits.length === 0) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setFailure(null);
          setSuccess(null);
          setProblem(null);
        }
      }}
    >
      <DialogTrigger render={<Button type="button" />}>Submit</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Submit basket</DialogTitle>
          <DialogDescription>Check the edits, then save them. Nothing is written until this succeeds.</DialogDescription>
        </DialogHeader>
        {checking ? <p data-testid="submit-checking">Checking the basket…</p> : null}
        {problem !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        ) : null}
        {results !== null && success === null ? (
          <ul className="flex flex-col gap-1">
            {results.map((result) => {
              const edit = edits[result.index];
              return (
                <li key={result.index} data-testid="validate-result" className="min-w-0 text-sm">
                  {edit === undefined ? (
                    `Edit ${result.index + 1}`
                  ) : (
                    <EditLabel edit={edit} titles={titles} />
                  )}
                  {result.ok ? null : `: ${result.error ?? "invalid"}`}
                </li>
              );
            })}
          </ul>
        ) : null}
        {success !== null ? (
          <SubmitResult
            success={success}
            edits={submitted}
            titles={titles}
            forgeRepo={config?.forgeRepo}
            onDone={() => {
              setOpen(false);
              setSuccess(null);
              setFailure(null);
              setProblem(null);
            }}
          />
        ) : null}
        {failure !== null ? (
          <p role="alert" data-testid="submit-error" className="text-sm text-destructive">
            {failure.error}
          </p>
        ) : null}
        {offerPr ? (
          <Button type="button" disabled={busy} onClick={() => void send("pr")}>
            Open a PR instead
          </Button>
        ) : null}
        {success === null && config !== null && config.modes.length > 0 ? (
          <fieldset className="flex flex-col gap-1" aria-labelledby={modeGroup}>
            <legend id={modeGroup} className="text-sm font-medium">
              Submit mode
            </legend>
            {config.modes.map((entry) => (
              <label key={entry} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={modeGroup}
                  value={entry}
                  checked={mode === entry}
                  onChange={() => chooseMode(entry)}
                />
                {formatSubmitMode(entry, config.directBranch)}
              </label>
            ))}
          </fieldset>
        ) : null}
        {success === null && needsGithubWrite ? (
          <a href={githubWriteHref(repoId)} className="text-sm underline">
            Connect GitHub
          </a>
        ) : null}
        {success === null && !needsGithubWrite ? (
          <Button type="button" disabled={!valid || busy || checking || config?.csrf === undefined} onClick={() => void send(mode)}>
            {busy ? "Submitting…" : "Submit edits"}
          </Button>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function SubmitResult({
  success,
  edits,
  titles,
  forgeRepo,
  onDone,
}: {
  success: SubmitSuccess;
  edits: readonly Edit[];
  titles?: ReadonlyMap<string, string>;
  forgeRepo?: string;
  onDone: () => void;
}) {
  const created = new Map((success.created ?? []).map((entry) => [entry.index, entry]));
  const short = success.commit.slice(0, 7);
  const commitHref = success.commitUrl ?? githubCommitHref(forgeRepo, success.commit);
  return (
    <div data-testid="submit-success" className="flex flex-col gap-2">
      <ul className="flex flex-col gap-1">
        {edits.map((edit, index) => {
          const made = created.get(index);
          return (
            <li key={index} data-testid="submitted-edit" className="min-w-0 text-sm">
              <EditLabel edit={edit} titles={titles} />
              {made !== undefined ? (
                <span data-testid="created-initiative" className="block text-xs text-muted-foreground">
                  Created {made.id ?? made.number ?? ""} at {made.path}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      {success.pr !== undefined && success.pr.url.startsWith("https://") ? (
        <p className="text-sm">
          <a href={success.pr.url} target="_blank" rel="noreferrer" data-testid="submit-pr" className="underline">
            Opened PR #{success.pr.number}
          </a>
        </p>
      ) : success.pr !== undefined ? (
        <p className="text-sm" data-testid="submit-pr">
          Opened PR #{success.pr.number}
        </p>
      ) : commitHref !== undefined ? (
        <p className="text-sm">
          <a href={commitHref} target="_blank" rel="noreferrer" data-testid="submit-commit" className="underline">
            Pushed {short} to {success.branch}
          </a>
        </p>
      ) : (
        <p className="text-sm" data-testid="submit-commit">
          Pushed {short} to {success.branch}
        </p>
      )}
      <Button type="button" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}

export function githubCommitHref(repo: string | undefined, sha: string): string | undefined {
  if (repo === undefined || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return undefined;
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) return undefined;
  return `https://github.com/${repo}/commit/${sha}`;
}

function readStoredMode(repoId: string): EditModeName | undefined {
  if (typeof localStorage === "undefined") return undefined;
  const stored = localStorage.getItem(submitModeStorageKey(repoId));
  if (stored === "pr" || stored === "direct") return stored;
  return undefined;
}

function parseResults(value: unknown): ValidateResult[] {
  if (!isRecord(value) || !Array.isArray(value.results)) return [];
  const results: ValidateResult[] = [];
  for (const entry of value.results) {
    if (!isRecord(entry) || typeof entry.index !== "number" || typeof entry.ok !== "boolean") continue;
    const error = typeof entry.error === "string" ? entry.error : undefined;
    results.push({ index: entry.index, ok: entry.ok, ...(error === undefined ? {} : { error }) });
  }
  return results;
}

function parseSubmit(value: unknown): SubmitSuccess | SubmitFailure | null {
  if (!isRecord(value) || typeof value.ok !== "boolean") return null;
  if (value.ok) {
    if (typeof value.commit !== "string" || typeof value.branch !== "string") return null;
    const mode: EditModeName = value.mode === "direct" ? "direct" : "pr";
    const success: SubmitSuccess = { ok: true, mode, commit: value.commit, branch: value.branch };
    if (isRecord(value.pr) && typeof value.pr.number === "number" && typeof value.pr.url === "string") {
      success.pr = { number: value.pr.number, url: value.pr.url };
    }
    if (typeof value.commitUrl === "string" && value.commitUrl.startsWith("https://")) success.commitUrl = value.commitUrl;
    if (Array.isArray(value.created)) {
      success.created = value.created.flatMap((entry): CreatedInitiative[] => {
        if (!isRecord(entry) || typeof entry.index !== "number" || typeof entry.path !== "string") return [];
        return [
          {
            index: entry.index,
            path: entry.path,
            ...(typeof entry.id === "string" ? { id: entry.id } : {}),
            ...(typeof entry.number === "string" ? { number: entry.number } : {}),
          },
        ];
      });
    }
    return success;
  }
  return {
    ok: false,
    code: typeof value.code === "string" ? value.code : "invalid",
    error: typeof value.error === "string" ? value.error : "The submit failed.",
    ...(value.alternativeMode === "pr" ? { alternativeMode: "pr" as const } : {}),
  };
}

function messageOf(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.error !== "string") return undefined;
  return value.error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Write grant for this repo; the server picks the scope from the repo's settings. */
export function githubWriteHref(repoId: string): string {
  const back = repoId === DEFAULT_REPO_ID ? "/" : `/r/${repoId}/`;
  return `/auth/github/write?repo=${encodeURIComponent(repoId)}&return=${encodeURIComponent(back)}`;
}
