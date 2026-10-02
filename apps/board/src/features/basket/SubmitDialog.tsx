import { useEffect, useId, useRef, useState } from "react";
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
import { DEFAULT_REPO_ID, describeEdit, useBasket } from "@/features/basket/store";
import {
  quickFixFor,
  readableError,
  recordValidation,
  type QuickFix,
  type ValidateResult,
} from "@/features/basket/validation";
import { CircleAlert, CircleCheck } from "lucide-react";
import type { Edit } from "snoboard/browser";
import { repoApi } from "@/lib/routes";
import { getImage } from "@/features/attachments/store";

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

/** Pending "submit after connecting GitHub", kept for one redirect round trip. */
export type ResumeIntent = { repoId: string; mode: EditModeName; basketHash: string; at: number };

export const RESUME_STORAGE_KEY = "snoboard:submit-resume:v1";
export const RESUME_PARAM = "resumeSubmit";
/** An intent older than the OAuth state cookie (10 min) is stale. */
const RESUME_MAX_AGE_MS = 10 * 60 * 1000;

/** Navigation seam so tests can watch the redirect instead of leaving the page. */
export const submitNavigation = {
  assign(url: string): void {
    window.location.assign(url);
  },
};

/** Stable fingerprint of the basket (cyrb53 over its JSON). Not a security check: it only detects changes. */
export function basketHash(edits: readonly Edit[]): string {
  const text = JSON.stringify(edits);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${edits.length}:${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`;
}

export function saveResumeIntent(intent: ResumeIntent): void {
  if (typeof sessionStorage === "undefined") return;
  sessionStorage.setItem(RESUME_STORAGE_KEY, JSON.stringify(intent));
}

/** Read and forget the intent for `repoId`. Wrong repo, stale or malformed: null. */
export function takeResumeIntent(repoId: string, now = Date.now()): ResumeIntent | null {
  if (typeof sessionStorage === "undefined") return null;
  const raw = sessionStorage.getItem(RESUME_STORAGE_KEY);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    sessionStorage.removeItem(RESUME_STORAGE_KEY);
    return null;
  }
  if (!isRecord(parsed) || parsed.repoId !== repoId) return null;
  sessionStorage.removeItem(RESUME_STORAGE_KEY);
  const { mode, basketHash: hash, at } = parsed;
  if ((mode !== "direct" && mode !== "pr") || typeof hash !== "string" || typeof at !== "number") return null;
  if (now - at > RESUME_MAX_AGE_MS || at > now + 60_000) return null;
  return { repoId, mode, basketHash: hash, at };
}

/** Current page with `?resumeSubmit=1`, as a same-origin path for the OAuth return. */
export function resumeReturnPath(location: Pick<Location, "pathname" | "search" | "hash">): string {
  const params = new URLSearchParams(location.search);
  params.set(RESUME_PARAM, "1");
  return `${location.pathname}?${params.toString()}${location.hash}`;
}

/** Drop `?resumeSubmit=1` from the address bar without a reload. */
function clearResumeParam(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(RESUME_PARAM)) return;
  url.searchParams.delete(RESUME_PARAM);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
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
  // Bumped after Remove or a quick fix so the basket is checked again.
  const [round, setRound] = useState(0);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<SubmitFailure | null>(null);
  const [success, setSuccess] = useState<SubmitSuccess | null>(null);
  // The basket is cleared on success; keep what was sent so the result can list it.
  const [submitted, setSubmitted] = useState<readonly Edit[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  // Set on return from GitHub: submit automatically once the basket checks out.
  const resume = useRef<{ mode: EditModeName; autoSubmit: boolean } | null>(null);
  // At most one automatic redirect per page load (and none right after a resume), so it cannot loop.
  const autoConnectUsed = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (new URLSearchParams(window.location.search).get(RESUME_PARAM) !== "1") return;
    const intent = takeResumeIntent(repoId);
    if (intent === null) return;
    clearResumeParam();
    autoConnectUsed.current = true;
    resume.current = { mode: intent.mode, autoSubmit: intent.basketHash === basketHash(basket.list()) };
    setOpen(true);
  }, [repoId, basket.list]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const edits = basket.list();
    setChecking(true);
    setResults(null);
    setFailure(null);
    setSuccess(null);
    setProblem(null);
    const validation =
      edits.length === 0
        ? Promise.resolve(null)
        : fetch(repoApi(repoId, "/edits/validate"), {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ edits }),
            signal: controller.signal,
          });
    void Promise.all([
      fetch(repoApi(repoId, "/edit-config"), { credentials: "same-origin", signal: controller.signal }),
      validation,
    ])
      .then(async ([configResponse, validateResponse]) => {
        if (controller.signal.aborted) return;
        const configBody: unknown = await configResponse.json().catch(() => null);
        const nextConfig = parseEditConfig(configBody);
        setConfig(nextConfig);
        const resumed = resume.current;
        setMode(
          resumed !== null && nextConfig.modes.includes(resumed.mode)
            ? resumed.mode
            : rememberedSubmitMode(repoId, nextConfig.modes, nextConfig.defaultMode),
        );
        if (validateResponse === null) {
          setResults([]);
          return;
        }
        if (!validateResponse.ok) {
          const validateBody: unknown = await validateResponse.json().catch(() => null);
          setProblem(messageOf(validateBody) ?? "Could not check the basket.");
          setResults(null);
          return;
        }
        const validateBody: unknown = await validateResponse.json().catch(() => null);
        const parsed = parseResults(validateBody);
        recordValidation(repoId, edits, parsed);
        setResults(parsed);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setProblem("Could not check the basket.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setChecking(false);
      });
    return () => controller.abort();
  }, [open, repoId, basket.list, round]);

  // After the check: connect GitHub automatically, or finish a resumed submit.
  useEffect(() => {
    if (!open || checking || results === null || config === null || success !== null || busy) return;
    const valid = results.filter((result) => result.ok).length;
    if (config.needsGithubWrite) {
      resume.current = null;
      if (valid > 0) connectGithub(mode, true);
      return;
    }
    const resumed = resume.current;
    if (resumed === null) return;
    resume.current = null;
    if (resumed.autoSubmit && valid > 0 && valid === results.length) void send(mode);
  });

  /** Remember what to submit, then go through the GitHub write grant and come back here. */
  function connectGithub(nextMode: EditModeName, automatic: boolean) {
    if (automatic && autoConnectUsed.current) return;
    autoConnectUsed.current = true;
    saveResumeIntent({ repoId, mode: nextMode, basketHash: basketHash(basket.list()), at: Date.now() });
    setConnecting(true);
    submitNavigation.assign(githubWriteHref(repoId, resumeReturnPath(window.location)));
  }

  function chooseMode(next: EditModeName) {
    setMode(next);
    rememberSubmitMode(repoId, next);
  }

  function recheck() {
    setResults(null);
    setRound((value) => value + 1);
  }

  function removeEdit(index: number) {
    basket.remove(index);
    recheck();
  }

  function applyFix(index: number, fix: QuickFix) {
    basket.insertBefore(index, fix.edits);
    recheck();
  }

  async function send(nextMode: EditModeName, onlyIndices?: readonly number[]) {
    const current = config;
    if (current?.csrf === undefined) {
      setProblem("Reload the board and try again.");
      return;
    }
    setBusy(true);
    setProblem(null);
    const all = basket.list();
    const picked = onlyIndices === undefined ? undefined : new Set(onlyIndices);
    const sent = picked === undefined ? all : all.filter((_, index) => picked.has(index));
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
        if (picked === undefined) {
          basket.clear();
        } else {
          // Invalid edits stay in the basket for a later fix.
          basket.retain(all.flatMap((_, index) => (picked.has(index) ? [] : [index])));
        }
        setFailure(null);
        setSuccess(parsed);
        return;
      }
      if (parsed.code === "needs_github_write" || (response.status === 401 && isRecord(body) && body.needsGithubWrite === true)) {
        // The effect above reconnects once; the link stays as a fallback.
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
  const failing = results === null ? [] : results.filter((result) => !result.ok);
  const validIndices = results === null ? [] : results.filter((result) => result.ok).map((result) => result.index);
  const allValid = results !== null && results.length > 0 && failing.length === 0;
  const someValid = failing.length > 0 && validIndices.length > 0;
  const needsGithubWrite = config?.needsGithubWrite === true;
  const offerPr =
    failure !== null &&
    (config?.modes.includes("pr") ?? false) &&
    (failure.alternativeMode === "pr" || failure.code === "direct_rejected" || failure.code === "branch_moved");
  const blockedReason = submitBlockedReason({ checking, config, results, problem, validCount: validIndices.length });

  // Nothing to submit and nothing to report: no trigger. Once open, the dialog
  // stays mounted after a successful submit clears the basket, so the result shows.
  if (!open && edits.length === 0) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          resume.current = null;
          setFailure(null);
          setSuccess(null);
          setProblem(null);
        }
      }}
    >
      <DialogTrigger render={<Button type="button" />}>Submit</DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
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
        {results !== null && success === null && results.length > 0 ? (
          failing.length > 0 ? (
            <p
              role="status"
              data-testid="validate-summary"
              className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-sm font-medium text-destructive"
            >
              <CircleAlert aria-hidden className="size-4 shrink-0" />
              {`${failing.length} of ${results.length} ${results.length === 1 ? "edit" : "edits"} ${failing.length === 1 ? "needs" : "need"} attention`}
            </p>
          ) : (
            <p role="status" data-testid="validate-summary" className="flex items-center gap-2 text-sm text-muted-foreground">
              <CircleCheck aria-hidden className="size-4 shrink-0 text-emerald-600" />
              {results.length === 1 ? "The edit is valid" : `All ${results.length} edits are valid`}
            </p>
          )
        ) : null}
        {results !== null && success === null && results.length > 0 ? (
          <ul className="flex min-w-0 max-h-[45vh] flex-col gap-1 overflow-y-auto overflow-x-hidden pr-1">
            {results.map((result) => {
              const edit = edits[result.index];
              const label = edit === undefined ? `Edit ${result.index + 1}` : describeEdit(edit, titles);
              const fix = result.ok ? undefined : quickFixFor(edit, result.error);
              return (
                <li
                  key={result.index}
                  data-testid="validate-result"
                  data-valid={result.ok ? "true" : "false"}
                  className={
                    result.ok
                      ? "min-w-0 px-2 text-sm"
                      : "flex min-w-0 flex-col gap-1 rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-sm"
                  }
                >
                  {edit === undefined ? label : <EditLabel edit={edit} titles={titles} />}
                  {result.ok ? null : (
                    <>
                      <span data-testid="validate-error" className="flex min-w-0 items-start gap-1.5 break-words text-destructive">
                        <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                        <span>{readableError(result.error)}</span>
                      </span>
                      <span className="flex flex-wrap gap-2">
                        {fix !== undefined ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={busy || checking}
                            onClick={() => applyFix(result.index, fix)}
                          >
                            {fix.label}
                          </Button>
                        ) : null}
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          aria-label={`Remove ${label}`}
                          disabled={busy || checking}
                          onClick={() => removeEdit(result.index)}
                        >
                          Remove
                        </Button>
                      </span>
                    </>
                  )}
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
            remaining={edits.length}
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
          <Button type="button" disabled={busy} onClick={() => void send("pr", someValid ? validIndices : undefined)}>
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
        {success === null && needsGithubWrite && connecting ? (
          <p role="status" data-testid="github-connecting" className="text-sm text-muted-foreground">
            Connecting to GitHub…
          </p>
        ) : null}
        {success === null && needsGithubWrite ? (
          <a
            href={githubWriteHref(repoId)}
            className="text-sm underline"
            onClick={(event) => {
              event.preventDefault();
              connectGithub(mode, false);
            }}
          >
            Connect GitHub
          </a>
        ) : null}
        {success === null && !needsGithubWrite && config?.githubLogin !== undefined ? (
          <p data-testid="github-connected" className="text-sm text-muted-foreground">
            Signed in to GitHub as {config.githubLogin}
          </p>
        ) : null}
        {success === null && !needsGithubWrite && config?.githubWriteConnect === true && config.githubLogin === undefined ? (
          <a href={githubWriteHref(repoId)} className="text-sm underline">
            Connect GitHub to commit as yourself
          </a>
        ) : null}
        {success === null && !needsGithubWrite ? (
          <div className="flex flex-col gap-1">
            {someValid ? (
              <>
                <Button
                  type="button"
                  disabled={busy || checking || config?.csrf === undefined}
                  onClick={() => void send(mode, validIndices)}
                >
                  {busy
                    ? "Submitting…"
                    : validIndices.length === 1
                      ? "Submit the 1 valid edit"
                      : `Submit the ${validIndices.length} valid edits`}
                </Button>
                <p data-testid="submit-partial-note" className="text-xs text-muted-foreground">
                  {failing.length === 1
                    ? "The edit marked above stays in the basket."
                    : `The ${failing.length} edits marked above stay in the basket.`}
                </p>
              </>
            ) : (
              <Button
                type="button"
                disabled={!allValid || busy || checking || config?.csrf === undefined}
                aria-describedby={blockedReason === null ? undefined : `${modeGroup}-blocked`}
                onClick={() => void send(mode)}
              >
                {busy ? "Submitting…" : "Submit edits"}
              </Button>
            )}
            {blockedReason !== null ? (
              <p id={`${modeGroup}-blocked`} data-testid="submit-blocked" className="text-xs text-muted-foreground">
                {blockedReason}
              </p>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** Why the submit button is disabled, or null when it is not (or the reason is already on screen). */
export function submitBlockedReason({
  checking,
  config,
  results,
  problem,
  validCount,
}: {
  checking: boolean;
  config: ClientEditConfig | null;
  results: readonly ValidateResult[] | null;
  problem: string | null;
  validCount: number;
}): string | null {
  if (checking) return null;
  if (config !== null && config.csrf === undefined) return "Reload the board and try again.";
  if (results === null) return problem === null ? null : "The basket could not be checked, so nothing can be submitted yet.";
  if (results.length === 0) return "The basket is empty.";
  if (validCount === 0) return "None of these edits can be submitted. Fix or remove the ones marked above.";
  return null;
}

function SubmitResult({
  success,
  edits,
  titles,
  forgeRepo,
  remaining = 0,
  onDone,
}: {
  success: SubmitSuccess;
  edits: readonly Edit[];
  titles?: ReadonlyMap<string, string>;
  forgeRepo?: string;
  remaining?: number;
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
      {remaining > 0 ? (
        <p data-testid="submit-remaining" className="text-sm text-muted-foreground">
          {remaining === 1 ? "1 edit stays" : `${remaining} edits stay`} in the basket to fix later.
        </p>
      ) : null}
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
export function githubWriteHref(repoId: string, returnPath?: string): string {
  const back = returnPath ?? (repoId === DEFAULT_REPO_ID ? "/" : `/r/${repoId}/`);
  return `/auth/github/write?repo=${encodeURIComponent(repoId)}&return=${encodeURIComponent(back)}`;
}
