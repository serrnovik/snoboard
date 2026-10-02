import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Context } from "hono";
import {
  ASSET_FILE,
  detectImageType,
  EditSchema,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_TOTAL_BYTES,
  MAX_ATTACHMENTS,
  summarizeEdit,
  type Config,
  type Edit,
  type Snapshot,
} from "snoboard";
import type { BoardEnv } from "../auth/middleware.js";
import { safeEqual } from "../auth/session.js";
import { sessionKeyOf } from "../auth/write-tokens.js";
import type { EditActor, EditMode, EditSettings } from "../edit-env.js";
import {
  addLabelBestEffort,
  type CommitFile,
  commitFiles,
  createBranch,
  deleteBranch,
  getFileEntry,
  getRef,
  GitHubWriteError,
  listBranches,
  listDirectory,
  openPullRequest,
  updateBranch,
  type GitHubCallOptions,
} from "../forge/github-write.js";
import { MAX_VALIDATE_EDITS, prepareEdits, type EditResult, type ReadBlob } from "./prepare.js";

export const SUBMIT_LIMIT_PER_HOUR = 10;
export const EDIT_BRANCH_PREFIX = "snoboard/edits-";
export const SNOBOARD_LABEL = "snoboard";
const HOUR_MS = 60 * 60 * 1000;
const MAX_BRANCHES_CHECKED = 20;
const PROJECT_SEGMENT = /^[a-z0-9][a-z0-9_-]*$/;
const FOLDER_SEGMENT = /^(\d{3})-[A-Za-z0-9][A-Za-z0-9._-]*$/;

// CSRF tokens are HMACs of the caller's subject under a per-process key.
// A restart rotates the key; the UI fetches /api/edit-config again.
let csrfKey = randomBytes(32);
const submitStamps = new Map<string, number[]>();
const inFlight = new Set<string>();

export function resetSubmitState(): void {
  csrfKey = randomBytes(32);
  submitStamps.clear();
  inFlight.clear();
}

/** Who is submitting, for CSRF binding and rate limits. Null when anonymous. */
export function submitSubject(c: Context<BoardEnv>): string | null {
  const identity = c.get("identity");
  if (identity !== undefined && identity.email.length > 0) return `cf:${identity.email.toLowerCase()}`;
  const session = c.get("session");
  if (session !== undefined) return `session:${sessionKeyOf(session)}`;
  return null;
}

/**
 * Who the rate limit and the in-flight lock count against: the person, not the
 * session. Signing in again (password or GitHub) must not reset the budget.
 */
export function rateSubject(c: Context<BoardEnv>): string | null {
  const identity = c.get("identity");
  if (identity !== undefined && identity.email.length > 0) return `cf:${identity.email.toLowerCase()}`;
  const session = c.get("session");
  if (session !== undefined) return `${session.method}:${session.sub.toLowerCase()}`;
  return null;
}

/** Display name for submit audit logs. Never a token, never edit content. */
export function submitLogName(c: Context<BoardEnv>): string {
  const identity = c.get("identity");
  if (identity !== undefined && identity.email.length > 0) return identity.email;
  const session = c.get("session");
  if (session !== undefined) return session.sub;
  return "anonymous";
}

/**
 * One info line per submit attempt: outcome, reason code, who, and how many
 * edits. Values are JSON-quoted so a crafted name cannot forge a log line.
 */
export function logSubmit(input: {
  outcome: "denied" | "failed" | "ok";
  reason: string;
  user: string;
  actor: string;
  repo?: string;
  mode?: string;
  edits?: number;
  attachments?: number;
  attachmentBytes?: number;
}): void {
  const parts = [
    `snoboard: submit ${input.outcome}`,
    `reason=${JSON.stringify(input.reason)}`,
    `user=${JSON.stringify(input.user.slice(0, 200))}`,
    `actor=${input.actor}`,
  ];
  if (input.repo !== undefined) parts.push(`repo=${JSON.stringify(input.repo.slice(0, 40))}`);
  if (input.mode !== undefined) parts.push(`mode=${JSON.stringify(input.mode.slice(0, 20))}`);
  if (input.edits !== undefined) parts.push(`edits=${input.edits}`);
  if (input.attachments !== undefined && input.attachments > 0) {
    parts.push(`attachments=${input.attachments}`, `attachment_bytes=${input.attachmentBytes ?? 0}`);
  }
  console.info(parts.join(" "));
}

export function issueCsrfToken(subject: string): string {
  return createHmac("sha256", csrfKey).update(`snoboard-submit-csrf-v1\n${subject}`).digest("base64url");
}

export function csrfMatches(subject: string, token: unknown): boolean {
  if (typeof token !== "string" || token.length === 0 || token.length > 128) return false;
  return safeEqual(token, issueCsrfToken(subject));
}

/** Counts this attempt. False once the subject used up its submits for the hour. */
export function allowSubmit(subject: string, now: number): boolean {
  const recent = (submitStamps.get(subject) ?? []).filter((stamp) => now - stamp < HOUR_MS);
  if (recent.length >= SUBMIT_LIMIT_PER_HOUR) {
    submitStamps.set(subject, recent);
    return false;
  }
  recent.push(now);
  submitStamps.set(subject, recent);
  return true;
}

export type SubmitBody = {
  edits: unknown[];
  mode: string;
  csrf: unknown;
  /** Optional echo of the target repo id; the path decides, a mismatch is rejected. */
  repo?: string;
  /** Image bytes keyed by their sha256 (hex), decoded from base64. */
  attachments: Map<string, Buffer>;
};

// Linear check (no nested groups) so a multi-megabyte string cannot blow the regex stack.
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;

/** `{ "<sha256>": "<base64>" }`. Count and size are checked before anything else runs. */
export function parseAttachments(value: unknown): Map<string, Buffer> | { error: string } {
  const map = new Map<string, Buffer>();
  if (value === undefined) return map;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { error: "invalid attachments" };
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_ATTACHMENTS) return { error: `at most ${MAX_ATTACHMENTS} images per submit` };
  let total = 0;
  for (const [sha, data] of entries) {
    if (!SHA256_HEX.test(sha) || typeof data !== "string" || data.length % 4 !== 0 || !BASE64.test(data)) {
      return { error: "invalid attachments" };
    }
    const bytes = Buffer.from(data, "base64");
    if (bytes.length > MAX_ATTACHMENT_BYTES) return { error: "an image is larger than 5 MB" };
    total += bytes.length;
    if (total > MAX_ATTACHMENT_TOTAL_BYTES) {
      return { error: `images in one submit are limited to ${MAX_ATTACHMENT_TOTAL_BYTES / (1024 * 1024)} MB` };
    }
    map.set(sha, bytes);
  }
  return map;
}

export function parseSubmitBody(raw: string): SubmitBody | { error: string } {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { error: "invalid json" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { error: "invalid edits" };
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.edits)) return { error: "invalid edits" };
  if (record.edits.length === 0) return { error: "no edits" };
  if (record.edits.length > MAX_VALIDATE_EDITS) return { error: "too many edits" };
  if (typeof record.mode !== "string") return { error: "invalid mode" };
  if (record.repo !== undefined && typeof record.repo !== "string") return { error: "invalid repo" };
  const attachments = parseAttachments(record.attachments);
  if ("error" in attachments) return attachments;
  return {
    edits: record.edits,
    mode: record.mode,
    csrf: record.csrf,
    attachments,
    ...(typeof record.repo === "string" ? { repo: record.repo } : {}),
  };
}

export type SubmitInput = {
  edits: readonly unknown[];
  mode: EditMode;
  settings: EditSettings;
  snapshot: Snapshot;
  config: Config;
  /** Reads the snapshot's blob from the local clone; used to tell unchanged files from re-applied ones. */
  localReader: ReadBlob;
  token: string;
  user: string;
  today: string;
  /** Image bytes keyed by sha256 hex; every `addAttachment` edit needs its bytes here. */
  attachments?: ReadonlyMap<string, Uint8Array>;
  now?: Date;
  options?: GitHubCallOptions;
};

export type SubmitSuccess = {
  ok: true;
  mode: EditMode;
  commit: string;
  branch: string;
  pr?: { number: number; url: string };
  reapplied: string[];
  warnings: string[];
  /** New initiatives in this commit, with the number the server assigned. */
  created?: CreatedInitiative[];
};

export type CreatedInitiative = { index: number; id?: string; number?: string; path: string };

export type SubmitFailureCode =
  | "rejected"
  | "path_not_allowed"
  | "number_taken"
  | "branch_moved"
  | "direct_rejected"
  | "pr_failed"
  | "github_auth"
  | "github_error";

export type SubmitFailure = {
  ok: false;
  code: SubmitFailureCode;
  error: string;
  results?: EditResult[];
  /** Set on `direct_rejected` when `pr` is allowed, so the UI can offer it in one click. */
  alternativeMode?: "pr";
};

export type SubmitOutcome = SubmitSuccess | SubmitFailure;

class SubmitStop extends Error {
  readonly failure: SubmitFailure;

  constructor(failure: SubmitFailure) {
    super(failure.error);
    this.failure = failure;
  }
}

/**
 * One commit or nothing. Every edit is re-validated against the target
 * branch head; a stale `from` (or any invalid edit) rejects the whole batch
 * before anything is written. `pr`: commit, branch, PR, then the label
 * (best-effort); a failed PR deletes the branch. `direct`: fast-forward with
 * the expected old sha, never forced, one retry when the branch moved.
 */
export async function submitEdits(input: SubmitInput): Promise<SubmitOutcome> {
  const { config, settings, mode, token, options } = input;
  const repo = config.forge.repo;
  const target =
    mode === "direct"
      ? (settings.directBranch ?? "")
      : (settings.baseBranch ?? config.defaultBranch);
  if (target.length === 0) return fail("github_error", "the target branch is not configured");
  const edits = parseEdits(input.edits);
  if ("results" in edits) {
    return { ok: false, code: "rejected", error: "some edits are invalid", results: edits.results };
  }
  const referenced = new Set(edits.list.flatMap((edit) => (edit.kind === "addAttachment" ? [edit.sha256] : [])));
  for (const sha of input.attachments?.keys() ?? []) {
    if (!referenced.has(sha)) return fail("rejected", "the request carries an image no edit uses");
  }

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const head = (await getRef(repo, target, token, options)).sha;
      const prepared = await prepareAtHead(input, edits.list, head);
      const message = commitMessage(edits.list, input.user);
      const commit = await commitFiles({ repo, token, baseSha: head, files: prepared.files, message }, options);

      if (mode === "pr") {
        const opened = await openEditPullRequest(input, edits.list, target, commit, prepared.reapplied);
        return opened.ok && prepared.created.length > 0 ? { ...opened, created: prepared.created } : opened;
      }
      try {
        await updateBranch(repo, target, commit, head, token, options);
      } catch (error) {
        if (error instanceof GitHubWriteError && error.code === "branch_moved" && attempt === 0) continue;
        if (error instanceof GitHubWriteError && error.code === "branch_moved") {
          return fail("branch_moved", `${target} kept moving; nothing was pushed. Try again.`);
        }
        if (error instanceof GitHubWriteError && (error.code === "rejected" || error.status === 403)) {
          return {
            ok: false,
            code: "direct_rejected",
            error: `GitHub refused the push to ${target} (branch protection?). Nothing was pushed.`,
            ...(settings.modes.includes("pr") ? { alternativeMode: "pr" as const } : {}),
          };
        }
        throw error;
      }
      return {
        ok: true,
        mode,
        commit,
        branch: target,
        reapplied: prepared.reapplied,
        warnings: [],
        ...(prepared.created.length > 0 ? { created: prepared.created } : {}),
      };
    }
    return fail("branch_moved", `${target} kept moving; nothing was pushed. Try again.`);
  } catch (error) {
    if (error instanceof SubmitStop) return error.failure;
    return githubFailure(error);
  }
}

async function prepareAtHead(
  input: SubmitInput,
  edits: readonly Edit[],
  head: string,
): Promise<{ files: CommitFile[]; reapplied: string[]; created: CreatedInitiative[] }> {
  const { config, token, options } = input;
  const repo = config.forge.repo;
  const reapplied = new Set<string>();
  const reader: ReadBlob = async (ref, filePath) => {
    if (!isEditablePath(filePath, config)) {
      throw new SubmitStop(fail("path_not_allowed", `path not allowed: ${filePath}`));
    }
    const remote = await getFileEntry(repo, head, filePath, token, options);
    if (remote === null) return undefined;
    const local = await input.localReader(ref, filePath).catch(() => undefined);
    if (local !== undefined && local.sha === remote.sha) return local;
    reapplied.add(filePath);
    return remote;
  };
  const prepared = await prepareEdits(edits, input.snapshot, reader, config, input.today);
  if (prepared.results.some((result) => !result.ok)) {
    throw new SubmitStop({
      ok: false,
      code: "rejected",
      error: "some edits no longer apply; nothing was committed",
      results: prepared.results,
    });
  }
  if (prepared.files.length === 0 && prepared.attachments.length === 0) {
    throw new SubmitStop(fail("rejected", "nothing to commit"));
  }
  for (const file of prepared.files) {
    if (!isEditablePath(file.path, config)) {
      throw new SubmitStop(fail("path_not_allowed", `path not allowed: ${file.path}`));
    }
    if (file.baseSha === null) await assertNumberFree(input, file.path, head);
  }
  const images: CommitFile[] = [];
  const listed = new Map<string, Promise<string[]>>();
  for (const attachment of prepared.attachments) {
    if (!isAttachmentPath(attachment.path, config)) {
      throw new SubmitStop(fail("path_not_allowed", `path not allowed: ${attachment.path}`));
    }
    const bytes = input.attachments?.get(attachment.sha256);
    const problem = attachmentProblem(bytes, attachment);
    if (problem !== undefined || bytes === undefined) {
      throw new SubmitStop(rejectedAt(attachment.index, `${attachment.path}: ${problem ?? "image data is missing"}`));
    }
    const dir = attachment.path.slice(0, attachment.path.lastIndexOf("/"));
    let names = listed.get(dir);
    if (names === undefined) {
      names = listDirectory(repo, head, dir, token, options);
      listed.set(dir, names);
    }
    const name = attachment.path.slice(dir.length + 1);
    if ((await names).includes(name)) {
      throw new SubmitStop(rejectedAt(attachment.index, `${attachment.path} already exists; rename the image`));
    }
    images.push({ path: attachment.path, base64: Buffer.from(bytes).toString("base64") });
  }
  return {
    files: [...prepared.files.map((file) => ({ path: file.path, text: file.text })), ...images],
    reapplied: [...reapplied].sort(),
    created: prepared.results.flatMap((result) =>
      edits[result.index]?.kind === "createInitiative" && result.path !== undefined
        ? [
            {
              index: result.index,
              path: result.path,
              ...(result.id === undefined ? {} : { id: result.id }),
              ...(result.number === undefined ? {} : { number: result.number }),
            },
          ]
        : [],
    ),
  };
}

/** Why these bytes do not match the edit (type by magic bytes, size, hash), or undefined. */
function attachmentProblem(
  bytes: Uint8Array | undefined,
  attachment: { contentType: string; sha256: string; size: number },
): string | undefined {
  if (bytes === undefined) return "image data is missing";
  if (bytes.length > MAX_ATTACHMENT_BYTES) return "image is larger than 5 MB";
  if (bytes.length !== attachment.size) return "image size does not match";
  if (createHash("sha256").update(bytes).digest("hex") !== attachment.sha256) return "image data does not match";
  const detected = detectImageType(bytes);
  if (detected === undefined) return "not a PNG, JPEG, WebP or GIF image";
  if (detected !== attachment.contentType) return `image is ${detected}, not ${attachment.contentType}`;
  return undefined;
}

function rejectedAt(index: number, error: string): SubmitFailure {
  return { ok: false, code: "rejected", error, results: [{ index, ok: false, error }] };
}

/** A new initiative's number must be free on the head and on every open edit branch. */
async function assertNumberFree(input: SubmitInput, filePath: string, head: string): Promise<void> {
  const { config, token, options } = input;
  const repo = config.forge.repo;
  const parts = filePath.slice(config.root.length + 1).split("/");
  const project = parts[0] ?? "";
  const number = FOLDER_SEGMENT.exec(parts[1] ?? "")?.[1];
  if (number === undefined) throw new SubmitStop(fail("path_not_allowed", `path not allowed: ${filePath}`));
  const projectDir = `${config.root}/${project}`;
  const refs = [head, ...(await listBranches(repo, EDIT_BRANCH_PREFIX, token, options)).slice(0, MAX_BRANCHES_CHECKED)];
  for (const ref of refs) {
    const names = await listDirectory(repo, ref, projectDir, token, options);
    if (names.some((name) => name.startsWith(`${number}-`))) {
      throw new SubmitStop(
        fail("number_taken", `${project}-${number} was taken meanwhile; validate the basket again`),
      );
    }
  }
}

async function openEditPullRequest(
  input: SubmitInput,
  edits: readonly Edit[],
  base: string,
  commit: string,
  reapplied: string[],
): Promise<SubmitOutcome> {
  const { config, token, options } = input;
  const repo = config.forge.repo;
  const branch = editBranchName(input.now ?? new Date());
  await createBranch(repo, branch, commit, token, options);
  let pr: { number: number; url: string };
  try {
    pr = await openPullRequest(
      {
        repo,
        head: branch,
        base,
        title: pullTitle(edits, input.user),
        body: pullBody(edits, input.user),
        token,
      },
      options,
    );
  } catch (error) {
    let cleaned = true;
    try {
      await deleteBranch(repo, branch, token, options);
    } catch {
      cleaned = false;
    }
    const authFailure = githubAuthFailure(error);
    if (authFailure !== undefined) return authFailure;
    const reason = error instanceof GitHubWriteError ? error.message : "GitHub request failed";
    return fail(
      "pr_failed",
      cleaned
        ? `the pull request could not be opened (${reason}); the branch was removed`
        : `the pull request could not be opened (${reason}); branch ${branch} could not be removed`,
    );
  }
  const labelled = await addLabelBestEffort(repo, pr.number, SNOBOARD_LABEL, token, options);
  return {
    ok: true,
    mode: "pr",
    commit,
    branch,
    pr,
    reapplied,
    warnings: labelled ? [] : [`label "${SNOBOARD_LABEL}" was not added`],
  };
}

export const PASSWORD_BOT_IDENTITY = "password-user";

export type SubmitCredential =
  | { ok: true; token: string; user: string }
  | { ok: false; code: "read_only"; error: string }
  | { ok: false; code: "needs_github_write"; error: string };

const READ_ONLY_ERROR = "this sign-in can view the board but not submit edits";

/**
 * GitHub users always submit with their own write token. Password and Access
 * users submit with the bot token when it is configured; everyone else is read-only.
 * The returned `user` is the commit trailer identity (`name (via bot)` for the bot).
 */
export function chooseSubmitCredential(input: {
  actor: EditActor;
  writeToken: { token: string; login: string } | null;
  botToken?: string;
  accessEmail?: string;
  passwordName?: string;
}): SubmitCredential {
  if (input.actor === "github") {
    if (input.writeToken === null || input.writeToken.token.length === 0) {
      return { ok: false, code: "needs_github_write", error: "connect GitHub write access first" };
    }
    const login = commitIdentity(input.writeToken.login);
    if (login === undefined) return { ok: false, code: "read_only", error: READ_ONLY_ERROR };
    return { ok: true, token: input.writeToken.token, user: login };
  }
  if (input.actor !== "password" && input.actor !== "cloudflare-access") {
    return { ok: false, code: "read_only", error: READ_ONLY_ERROR };
  }
  const botToken = input.botToken?.trim() ?? "";
  if (botToken.length === 0) return { ok: false, code: "read_only", error: READ_ONLY_ERROR };
  const identity =
    input.actor === "password" ? passwordIdentity(input.passwordName) : commitIdentity(input.accessEmail);
  if (identity === undefined) return { ok: false, code: "read_only", error: READ_ONLY_ERROR };
  return { ok: true, token: botToken, user: `${identity} (via bot)` };
}

/** Password commits say `password-user` unless a display name is configured. */
export function passwordIdentity(name: string | undefined): string {
  return commitIdentity(name) ?? PASSWORD_BOT_IDENTITY;
}

/** Token file contents, or undefined when the file is missing, empty, or not a single line. */
export function readBotTokenFile(filePath: string | undefined): string | undefined {
  const target = filePath?.trim();
  if (target === undefined || target.length === 0) return undefined;
  try {
    const token = readFileSync(target, "utf8").trim();
    if (token.length === 0 || token.length > 2048 || /[\r\n\0]/.test(token)) return undefined;
    return token;
  } catch {
    return undefined;
  }
}

function commitIdentity(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0 || trimmed.length > 200 || /[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  return trimmed;
}

export function commitMessage(edits: readonly Edit[], user: string): string {
  const lines = edits.map((edit) => `Snoboard-Edit: ${summarizeEdit(edit)}`);
  return [
    `snoboard: ${edits.length} ${edits.length === 1 ? "edit" : "edits"} by ${user}`,
    "",
    ...lines,
    `Snoboard-Edit-By: ${user}`,
    "",
  ].join("\n");
}

export function editBranchName(now: Date): string {
  const iso = now.toISOString();
  const stamp = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
  return `${EDIT_BRANCH_PREFIX}${stamp}-${randomBytes(2).toString("hex")}`;
}

/** `<root>/<project>/<NNN>-<slug>/assets/<name>.<png|jpg|webp|gif>` and nothing else. */
export function isAttachmentPath(filePath: string, config: Config): boolean {
  const marker = "/assets/";
  const at = filePath.lastIndexOf(marker);
  if (at === -1) return false;
  const file = filePath.slice(at + marker.length);
  return ASSET_FILE.test(file) && isEditablePath(`${filePath.slice(0, at)}/${config.file}`, config);
}

/** `<root>/<project>/<NNN>-<slug>/<file>` and nothing else. */
export function isEditablePath(filePath: string, config: Config): boolean {
  if (filePath.length === 0 || filePath.length > 512) return false;
  if (filePath.includes("\\") || filePath.includes("\0") || filePath.includes(":")) return false;
  const all = filePath.split("/");
  if (all.some((part) => part.length === 0 || part === "." || part === "..")) return false;
  const prefix = `${config.root}/`;
  if (!filePath.startsWith(prefix)) return false;
  const parts = filePath.slice(prefix.length).split("/");
  if (parts.length !== 3) return false;
  const [project, folder, file] = parts;
  return (
    project !== undefined &&
    PROJECT_SEGMENT.test(project) &&
    folder !== undefined &&
    FOLDER_SEGMENT.test(folder) &&
    file === config.file
  );
}

function pullTitle(edits: readonly Edit[], user: string): string {
  const first = edits[0];
  const title =
    edits.length === 1 && first !== undefined
      ? `snoboard: ${summarizeEdit(first)}`
      : `snoboard: ${edits.length} edits by ${user}`;
  return title.length > 200 ? `${title.slice(0, 199)}…` : title;
}

function pullBody(edits: readonly Edit[], user: string): string {
  return [
    `Edits submitted from Snoboard by ${user}.`,
    "",
    ...edits.map((edit) => `- ${summarizeEdit(edit)}`),
    "",
  ].join("\n");
}

function parseEdits(raw: readonly unknown[]): { list: Edit[] } | { results: EditResult[] } {
  const list: Edit[] = [];
  const results: EditResult[] = [];
  raw.forEach((value, index) => {
    const parsed = EditSchema.safeParse(value);
    if (parsed.success) {
      list.push(parsed.data);
      results.push({ index, ok: true });
    } else {
      results.push({ index, ok: false, error: "invalid edit" });
    }
  });
  if (results.some((result) => !result.ok)) return { results };
  return { list };
}

/** 401, or 403/404 (a token that works for one repository may not reach another), means reconnect. */
function githubAuthFailure(error: unknown): SubmitFailure | undefined {
  if (!(error instanceof GitHubWriteError)) return undefined;
  if (error.status === 401) return fail("github_auth", "GitHub no longer accepts the write token; reconnect GitHub");
  const tokenCannotReachRepo = error.status === 403 || error.status === 404;
  if (tokenCannotReachRepo) {
    return fail("github_auth", "the write token cannot reach this repository; reconnect GitHub");
  }
  return undefined;
}

function githubFailure(error: unknown): SubmitFailure {
  const authFailure = githubAuthFailure(error);
  if (authFailure !== undefined) return authFailure;
  // Messages from the client are already scrubbed of the token.
  if (error instanceof GitHubWriteError) return fail("github_error", error.message);
  return fail("github_error", "the submit failed; nothing was pushed");
}

function fail(code: SubmitFailureCode, error: string): SubmitFailure {
  return { ok: false, code, error };
}

export function lockSubmit(subject: string): boolean {
  if (inFlight.has(subject)) return false;
  inFlight.add(subject);
  return true;
}

export function unlockSubmit(subject: string): void {
  inFlight.delete(subject);
}
