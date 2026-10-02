import type { Context } from "hono";
import { Hono } from "hono";
import {
  ASSET_FILE,
  blockedChain,
  bodyHash,
  detectImageType,
  MAX_ATTACHMENT_BYTES,
  MAX_SUBMIT_BODY_BYTES,
  type Config,
} from "snoboard";
import { getAuthConfig } from "./auth/env.js";
import { authMiddleware, type BoardEnv } from "./auth/middleware.js";
import {
  MAX_VALIDATE_BODY_BYTES,
  MAX_VALIDATE_EDITS,
  prepareEdits,
  readRepoBlobs,
  type BlobContent,
  type ReadBlob,
} from "./edits/prepare.js";
import {
  allowSubmit,
  chooseSubmitCredential,
  csrfMatches,
  issueCsrfToken,
  lockSubmit,
  logSubmit,
  parseSubmitBody,
  rateSubject,
  readBotTokenFile,
  submitEdits,
  submitLogName,
  submitSubject,
  unlockSubmit,
  type SubmitOutcome,
} from "./edits/submit.js";
import { clearWriteToken, getWriteToken } from "./auth/write-tokens.js";
import { enrichPulls, githubTokenFromEnv } from "./forge/github.js";
import { initiativeRepoDir, readCommittedBytes, readCommittedFile, requestRefresh } from "./repo-sync.js";
import { defaultEditMode, editPermissions, type EditActor, type EditMode } from "./edit-env.js";
import { getProposals } from "./proposals.js";
import { boardIssueLinks, fetchInitiativeIssues, issueLinkConfig } from "./issues/setup.js";
import { botTokenFileFor, editSettingsFor, findActiveRepo, listActiveRepos } from "./repos-config.js";
import { DEFAULT_REPO_ID, getConfig, getSnapshot, getStatus } from "./store.js";

const REFRESH_WINDOW_MS = 30_000;
const REPO_ID = /^[a-z0-9-]{1,32}$/;

const lastRefreshAt = new Map<string, number>();

export function resetRefreshLimits(): void {
  lastRefreshAt.clear();
}

function refreshSubject(c: Context<BoardEnv>): string {
  const identity = c.get("identity");
  if (identity !== undefined && identity.email.length > 0) return identity.email;
  const session = c.get("session");
  if (session === undefined || session.sub.length === 0) return "anonymous";
  return session.sub;
}

function allowRefresh(repoId: string, session: string, now: number): boolean {
  const key = `${repoId}\n${session}`;
  const previous = lastRefreshAt.get(key);
  if (previous !== undefined && now - previous < REFRESH_WINDOW_MS) {
    return false;
  }
  lastRefreshAt.set(key, now);
  return true;
}

function isKnownRepo(id: string): boolean {
  if (!REPO_ID.test(id)) return false;
  const repos = listActiveRepos();
  if (repos.length === 0) return id === DEFAULT_REPO_ID;
  return repos.some((repo) => repo.id === id);
}

function firstRepoId(): string {
  return listActiveRepos()[0]?.id ?? DEFAULT_REPO_ID;
}

function settingsFor(repoId: string) {
  return editSettingsFor(repoId);
}

export const api = new Hono<BoardEnv>();

api.use("*", authMiddleware);
api.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});

api.get("/session", (c) => {
  const identity = c.get("identity");
  if (identity !== undefined) return c.json({ email: identity.email });
  const session = c.get("session");
  if (session === undefined) return c.json({ email: null });
  return c.json({ email: sessionEmail(session.sub) });
});

function sessionEmail(sub: string): string | null {
  if (sub.length === 0 || sub.length > 254 || !sub.includes("@")) return null;
  return sub;
}

api.get("/repos", (c) => {
  const configured = listActiveRepos();
  const repos =
    configured.length === 0
      ? [{ id: DEFAULT_REPO_ID, name: DEFAULT_REPO_ID }]
      : configured.map((repo) => ({ id: repo.id, name: repo.name }));
  return c.json(repos.map((repo) => ({ id: repo.id, name: repo.name, status: getStatus(repo.id) })));
});

api.get("/repos/:repo/edit-config", (c) => {
  const repoId = c.req.param("repo");
  if (!isKnownRepo(repoId)) return c.json({ error: "not found" }, 404);
  return editConfigJson(c, repoId);
});

api.get("/edit-config", (c) => editConfigJson(c, firstRepoId()));

function editConfigJson(c: Context<BoardEnv>, repoId: string) {
  const settings = settingsFor(repoId);
  const board = getConfig(repoId);
  const baseBranch = settings.baseBranch ?? board?.defaultBranch ?? "main";
  const actor = editActor(c);
  const writeConnect = githubWriteConnect();
  const access = editPermissions(settings, actor, { githubWriteConnect: writeConnect });
  const subject = submitSubject(c);
  const connected = access.canSubmit && (actor === "github" || (actor === "cloudflare-access" && writeConnect)) ? getWriteToken(c) : null;
  return c.json({
    enabled: settings.enabled,
    modes: settings.modes,
    baseBranch,
    ...(settings.directBranch === undefined ? {} : { directBranch: settings.directBranch }),
    canSubmit: access.canSubmit,
    // A GitHub user who already granted write access must see Submit, not Connect again.
    needsGithubWrite: access.needsGithubWrite && connected === null,
    // Access boards with write-connect: the UI offers "Connect GitHub" (commit as yourself)
    // and shows who is connected. Only the login, never the token.
    ...(actor === "cloudflare-access" && writeConnect && access.canSubmit ? { githubWriteConnect: true } : {}),
    ...(connected !== null ? { githubLogin: connected.login } : {}),
    defaultMode: defaultEditMode(settings),
    // owner/name for building https://github.com links in the UI.
    ...(board !== null && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(board.forge.repo) && board.forge.repo !== "owner/name"
      ? { forgeRepo: board.forge.repo }
      : {}),
    // Tracker links for pasted URLs and chips. Never includes tokens.
    issues: issueLinkConfig(repoId),
    // Echoed back by POST /api/edits/submit. Bound to this session or Access identity.
    ...(access.canSubmit && subject !== null ? { csrf: issueCsrfToken(subject) } : {}),
  });
}

/** Access board whose GitHub OAuth client may connect write tokens (SNOBOARD_GITHUB_WRITE_CONNECT). */
function githubWriteConnect(): boolean {
  const config = getAuthConfig();
  return config.githubWriteConnect === true && config.modes.includes("cloudflare-access") && config.github !== undefined;
}

function editActor(c: Context<BoardEnv>): EditActor {
  if (c.get("identity") !== undefined) return "cloudflare-access";
  const session = c.get("session");
  if (session?.method === "github") return "github";
  if (session?.method === "password") return "password";
  return "anonymous";
}

api.get("/repos/:repo/board", (c) => {
  const repoId = c.req.param("repo");
  if (!isKnownRepo(repoId)) return c.json({ error: "not found" }, 404);
  return boardJson(c, repoId);
});

api.get("/board", (c) => boardJson(c, firstRepoId()));

/**
 * No snapshot yet. While the first sync is in flight this is warmup ("snapshot not ready",
 * which the client retries). Once that sync has failed, return the stored git error instead.
 */
function notReadyJson(c: Context<BoardEnv>, repoId: string) {
  const status = getStatus(repoId);
  if (status.lastError === null) {
    return c.json({ error: "snapshot not ready" }, 503);
  }
  return c.json({ error: `repository sync failed: ${status.lastError}`, code: "sync_failed", status }, 503);
}

function boardJson(c: Context<BoardEnv>, repoId: string) {
  const snapshot = getSnapshot(repoId);
  const config = getConfig(repoId);
  if (snapshot === null || config === null) return notReadyJson(c, repoId);
  return c.json({
    status: getStatus(repoId),
    config: {
      statuses: config.statuses,
      priorities: config.priorities,
      doneStatuses: config.doneStatuses,
      staleAfterDays: config.staleAfterDays,
    },
    items: snapshot.items.map((item) => ({
      ...item,
      issues: boardIssueLinks(repoId, item.issues),
    })),
    legacy: snapshot.legacy,
    errors: snapshot.errors,
    refs: snapshot.refs,
    proposals: getProposals(repoId),
  });
}

api.get("/repos/:repo/initiatives/:id/body", async (c) => {
  const repoId = c.req.param("repo");
  if (!isKnownRepo(repoId)) return c.json({ error: "not found" }, 404);
  return initiativeBodyJson(c, repoId);
});

api.get("/initiatives/:id/body", (c) => initiativeBodyJson(c, firstRepoId()));

async function initiativeBodyJson(c: Context<BoardEnv>, repoId: string) {
  const snapshot = getSnapshot(repoId);
  if (snapshot === null) return notReadyJson(c, repoId);
  const item = snapshot.items.find((entry) => entry.id === c.req.param("id"));
  if (item === undefined) return c.json({ error: "not found" }, 404);
  const repoDir = initiativeRepoDir(repoId);
  if (repoDir === undefined) return c.json({ error: "snapshot not ready" }, 503);
  let text: string;
  try {
    text = await readCommittedFile(repoDir, item.sourceSha, item.path);
  } catch {
    return c.json({ error: "not found" }, 404);
  }
  const body = initiativeBody(text);
  if (body === null) return c.json({ error: "not found" }, 404);
  return c.json({ body, hash: bodyHash(text) });
}

api.get("/repos/:repo/initiatives/:id/assets/:file", async (c) => {
  const repoId = c.req.param("repo");
  if (!isKnownRepo(repoId)) return assetNotFound(c);
  return initiativeAssetResponse(c, repoId);
});

api.get("/initiatives/:id/assets/:file", (c) => initiativeAssetResponse(c, firstRepoId()));

function assetNotFound(c: Context<BoardEnv>): Response {
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Content-Security-Policy", "default-src 'none'");
  return c.json({ error: "not found" }, 404);
}

/**
 * A committed image under `<initiative folder>/assets/`, read from the clone at the
 * snapshot's commit. Only PNG, JPEG, WebP and GIF (by magic bytes); never SVG.
 * The file name must match `ASSET_FILE`, so `..`, `/` and encoded tricks never reach git.
 */
async function initiativeAssetResponse(c: Context<BoardEnv>, repoId: string): Promise<Response> {
  const file = c.req.param("file") ?? "";
  if (!ASSET_FILE.test(file)) return assetNotFound(c);
  const snapshot = getSnapshot(repoId);
  if (snapshot === null) return assetNotFound(c);
  const item = snapshot.items.find((entry) => entry.id === c.req.param("id"));
  if (item === undefined) return assetNotFound(c);
  const repoDir = initiativeRepoDir(repoId);
  if (repoDir === undefined) return assetNotFound(c);
  const folder = item.path.slice(0, item.path.lastIndexOf("/"));
  const bytes = await readCommittedBytes(repoDir, item.sourceSha, `${folder}/assets/${file}`, MAX_ATTACHMENT_BYTES).catch(
    () => undefined,
  );
  const type = bytes === undefined ? undefined : detectImageType(bytes);
  if (bytes === undefined || type === undefined) return assetNotFound(c);
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": type,
      "Content-Length": String(bytes.length),
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Cache-Control": "private, no-store",
    },
  });
}

api.get("/repos/:repo/initiatives/:id", async (c) => {
  const repoId = c.req.param("repo");
  if (!isKnownRepo(repoId)) return c.json({ error: "not found" }, 404);
  return initiativeJson(c, repoId);
});

api.get("/initiatives/:id", (c) => initiativeJson(c, firstRepoId()));

async function initiativeJson(c: Context<BoardEnv>, repoId: string) {
  const snapshot = getSnapshot(repoId);
  if (snapshot === null) return notReadyJson(c, repoId);
  const id = c.req.param("id");
  const idMissing = id === undefined || id.length === 0;
  if (idMissing) return c.json({ error: "not found" }, 404);
  const item = snapshot.items.find((entry) => entry.id === id);
  if (item === undefined) {
    return c.json({ error: "not found" }, 404);
  }
  const dependents = dependentIds(snapshot.graph.edges, id);
  const config = getConfig(repoId);
  const pullNumbers = (item.phases ?? []).flatMap((phase) => (phase.pr === undefined ? [] : [phase.pr]));
  const [prs, issues] = await Promise.all([
    loadPulls(config, pullNumbers),
    fetchInitiativeIssues(repoId, item.issues),
  ]);
  return c.json({
    ...item,
    blockedChain: blockedChain(snapshot.graph, id),
    dependents,
    issues,
    ...(config === null ? {} : { forge: config.forge }),
    ...(prs === undefined ? {} : { prs }),
  });
}

/** Body text is everything after the closing frontmatter fence, matching core `bodyHash`. */
function initiativeBody(text: string): string | null {
  const source = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const match = /^(---)(\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))([\s\S]*)$/.exec(source);
  if (match === null) return null;
  return match[5] ?? "";
}

function initiativeId(nodeId: string): string {
  const hash = nodeId.indexOf("#");
  if (hash === -1) return nodeId;
  return nodeId.slice(0, hash);
}

function dependentIds(edges: readonly { from: string; to: string }[], id: string): string[] {
  const prefix = `${id}#`;
  const dependents = new Set<string>();
  for (const edge of edges) {
    if (edge.from !== id && !edge.from.startsWith(prefix)) continue;
    const target = initiativeId(edge.to);
    if (target === id) continue;
    dependents.add(target);
  }
  return [...dependents].sort((left, right) => left.localeCompare(right));
}

async function loadPulls(
  config: ReturnType<typeof getConfig>,
  pullNumbers: readonly number[],
): Promise<Awaited<ReturnType<typeof enrichPulls>>> {
  if (config === null) return undefined;
  try {
    return await enrichPulls({
      repo: config.forge.repo,
      token: githubTokenFromEnv(),
      pullNumbers,
    });
  } catch {
    return undefined;
  }
}

api.post("/repos/:repo/refresh", (c) => {
  const repoId = c.req.param("repo");
  if (!isKnownRepo(repoId)) return c.json({ error: "not found" }, 404);
  return refreshJson(c, repoId);
});

api.post("/refresh", (c) => refreshJson(c, firstRepoId()));

function refreshJson(c: Context<BoardEnv>, repoId: string) {
  const session = refreshSubject(c);
  if (!allowRefresh(repoId, session, Date.now())) {
    return c.json({ error: "refresh rate limited" }, 429);
  }
  void requestRefresh(repoId);
  return c.json({ accepted: true }, 202);
}

api.post("/repos/:repo/edits/validate", async (c) => {
  const repoId = c.req.param("repo");
  if (!isKnownRepo(repoId)) return c.json({ error: "not found" }, 404);
  return validateJson(c, repoId);
});

api.post("/edits/validate", (c) => validateJson(c, firstRepoId()));

async function validateJson(c: Context<BoardEnv>, repoId: string) {
  const raw = await c.req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_VALIDATE_BODY_BYTES) {
    return c.json({ error: "payload too large" }, 413);
  }
  const parsed = parseValidateBody(raw);
  if (parsed === "invalid-json") return c.json({ error: "invalid json" }, 400);
  if (parsed === "invalid") return c.json({ error: "invalid edits" }, 400);
  if (parsed === "too-many") return c.json({ error: "too many edits" }, 400);

  const snapshot = getSnapshot(repoId);
  const config = getConfig(repoId);
  if (snapshot === null || config === null) {
    return c.json({ error: "snapshot not ready" }, 503);
  }
  const prepared = await prepareEdits(parsed, snapshot, readerFor(initiativeRepoDir(repoId), config), config, utcToday());
  return c.json({
    results: prepared.results,
    files: prepared.files.map((file) => ({ path: file.path, baseSha: file.baseSha })),
  });
}

api.post("/repos/:repo/edits/submit", async (c) => {
  const repoId = c.req.param("repo");
  if (!isKnownRepo(repoId)) return c.json({ error: "not found" }, 404);
  return submitJson(c, repoId);
});

api.post("/edits/submit", (c) => submitJson(c, firstRepoId()));

async function submitJson(c: Context<BoardEnv>, repoId: string) {
  const actor = editActor(c);
  const who = submitLogName(c);
  const deny = (
    status: 400 | 401 | 403 | 409 | 413 | 429 | 503,
    payload: { code: string; error: string } & Record<string, unknown>,
    extra?: { mode?: string; edits?: number; attachments?: number; attachmentBytes?: number },
  ): Response => {
    logSubmit({ outcome: "denied", reason: payload.code, user: who, actor, repo: repoId, ...extra });
    return c.json({ ok: false, ...payload }, status);
  };
  const raw = await c.req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_SUBMIT_BODY_BYTES) {
    return deny(413, { code: "too_large", error: "the submit is too large; images are limited to 8 MB per submit" });
  }
  const settings = settingsFor(repoId);
  if (!settings.enabled) return deny(403, { code: "editing_disabled", error: "editing is off" });
  const subject = submitSubject(c);
  const limitKey = rateSubject(c);
  if (subject === null || limitKey === null) return deny(403, { code: "read_only", error: "sign in to submit edits" });
  const body = parseSubmitBody(raw);
  if ("error" in body) return deny(400, { code: "invalid", error: body.error });
  const attachmentBytes = [...body.attachments.values()].reduce((sum, bytes) => sum + bytes.length, 0);
  const extra = { mode: body.mode, edits: body.edits.length, attachments: body.attachments.size, attachmentBytes };
  // Everything except the base64 images keeps the 64 KiB batch limit.
  const imageChars = [...body.attachments.values()].reduce((sum, bytes) => sum + 4 * Math.ceil(bytes.length / 3), 0);
  if (Buffer.byteLength(raw, "utf8") - imageChars > MAX_VALIDATE_BODY_BYTES) {
    return deny(413, { code: "too_large", error: "payload too large" }, extra);
  }
  // The path is the only source of the target repo; a body that names another repo is refused.
  const bodyNamesAnotherRepo = body.repo !== undefined && body.repo !== repoId;
  if (bodyNamesAnotherRepo) {
    return deny(400, { code: "repo_mismatch", error: "these edits belong to another repository" }, extra);
  }
  const writeConnect = actor === "cloudflare-access" && githubWriteConnect();
  const access = editPermissions(settings, actor, { githubWriteConnect: writeConnect });
  if (!access.canSubmit) {
    return deny(403, { code: "read_only", error: "this sign-in can view the board but not submit edits" }, extra);
  }
  if (!csrfMatches(subject, body.csrf)) {
    return deny(403, { code: "csrf", error: "reload the board and try again" }, extra);
  }
  if (!isAllowedMode(body.mode, settings.modes)) {
    return deny(400, { code: "mode_not_allowed", error: "this submit mode is not enabled" }, extra);
  }
  const credential = chooseSubmitCredential({
    actor,
    writeToken: actor === "github" || writeConnect ? getWriteToken(c) : null,
    botToken:
      actor === "password" || actor === "cloudflare-access"
        ? readBotTokenFile(botTokenFileFor(repoId))
        : undefined,
    accessEmail: c.get("identity")?.email,
    passwordName: process.env.SNOBOARD_PASSWORD_NAME,
    githubWriteConnect: writeConnect,
  });
  if (!credential.ok) {
    if (credential.code === "needs_github_write") {
      return deny(401, { code: credential.code, error: credential.error, needsGithubWrite: true }, extra);
    }
    return deny(403, { code: credential.code, error: credential.error }, extra);
  }
  const github = credential.githubLogin;
  const logged = github === undefined ? extra : { ...extra, github };
  const snapshot = getSnapshot(repoId);
  const config = getConfig(repoId);
  if (snapshot === null || config === null) {
    return deny(503, { code: "not_ready", error: "snapshot not ready" }, extra);
  }
  // The token was chosen for this repo id; never send it to another GitHub repo named
  // by the clone's own `.snoboard.yml`.
  const cloneRepo = githubRepoFromUrl(cloneUrlFor(repoId));
  const forgeIsAnotherRepo = cloneRepo !== undefined && cloneRepo.toLowerCase() !== config.forge.repo.trim().toLowerCase();
  if (forgeIsAnotherRepo) {
    return deny(409, { code: "forge_mismatch", error: "forge.repo does not match this repository's clone URL" }, extra);
  }
  if (!allowSubmit(limitKey, Date.now())) {
    c.header("Retry-After", "3600");
    return deny(429, { code: "rate_limited", error: "too many submits; try again later" }, extra);
  }
  if (!lockSubmit(limitKey)) {
    return deny(409, { code: "in_progress", error: "a submit is already running" }, extra);
  }
  let outcome: SubmitOutcome;
  try {
    outcome = await submitEdits({
      edits: body.edits,
      mode: body.mode,
      settings,
      snapshot,
      config,
      localReader: readerFor(initiativeRepoDir(repoId), config),
      token: credential.token,
      user: credential.user,
      today: utcToday(),
      attachments: body.attachments,
    });
  } finally {
    unlockSubmit(limitKey);
  }
  if (outcome.ok) {
    logSubmit({ outcome: "ok", reason: "ok", user: who, actor, repo: repoId, ...logged });
    void requestRefresh(repoId);
    const commitUrl = githubCommitUrl(config.forge.repo, outcome.commit);
    return c.json(commitUrl === undefined ? outcome : { ...outcome, commitUrl }, 200);
  }
  logSubmit({ outcome: "failed", reason: outcome.code, user: who, actor, repo: repoId, ...logged });
  if (outcome.code === "github_auth") {
    if (actor === "github" || github !== undefined) {
      clearWriteToken(c);
      return c.json({ ...outcome, needsGithubWrite: true }, 401);
    }
    return c.json({ ok: false, code: "github_auth", error: "GitHub rejected the bot token; nothing was pushed" }, 401);
  }
  return c.json(outcome, submitStatus(outcome.code));
}

function cloneUrlFor(repoId: string): string | undefined {
  const configured = findActiveRepo(repoId);
  if (configured !== undefined) return configured.url;
  const singleRepoBoard = listActiveRepos().length === 0 && repoId === DEFAULT_REPO_ID;
  return singleRepoBoard ? process.env.SNOBOARD_REPO_URL : undefined;
}

/** `owner/name` for a github.com https or ssh clone URL; undefined for any other host. */
export function githubRepoFromUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  const match = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
    url.trim(),
  );
  return match?.[1];
}

function githubCommitUrl(repo: string, sha: string): string | undefined {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return undefined;
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) return undefined;
  return `https://github.com/${repo}/commit/${sha}`;
}

function isAllowedMode(mode: string, allowed: readonly EditMode[]): mode is EditMode {
  return (allowed as readonly string[]).includes(mode);
}

function submitStatus(code: Exclude<SubmitOutcome, { ok: true }>["code"]): 400 | 409 | 502 {
  switch (code) {
    case "path_not_allowed":
      return 400;
    case "rejected":
    case "number_taken":
    case "branch_moved":
    case "direct_rejected":
      return 409;
    default:
      return 502;
  }
}

function parseValidateBody(raw: string): unknown[] | "invalid-json" | "invalid" | "too-many" {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return "invalid-json";
  }
  if (!isRecord(value)) return "invalid";
  const edits = value.edits;
  if (!Array.isArray(edits)) return "invalid";
  if (edits.length > MAX_VALIDATE_EDITS) return "too-many";
  return edits;
}

function readerFor(repoDir: string | undefined, config: Config): ReadBlob {
  if (repoDir === undefined) return async () => undefined;
  const cache = new Map<string, Promise<Map<string, BlobContent>>>();
  return async (ref, filePath) => {
    let pending = cache.get(ref);
    if (pending === undefined) {
      pending = readRepoBlobs(repoDir, ref, config);
      cache.set(ref, pending);
    }
    return (await pending).get(filePath);
  };
}

function utcToday(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
