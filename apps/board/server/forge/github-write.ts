export const GITHUB_WRITE_TIMEOUT_MS = 10_000;

const GITHUB_API = "https://api.github.com";
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export type GitHubCallOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/**
 * `branch_moved`: the branch tip is no longer the expected sha.
 * `rejected`: the tip did not move, GitHub still refused the update (branch protection, rulesets).
 */
export type GitHubWriteErrorCode = "branch_moved" | "rejected";

export class GitHubWriteError extends Error {
  readonly status: number | undefined;
  readonly code: GitHubWriteErrorCode | undefined;

  constructor(message: string, status?: number, code?: GitHubWriteErrorCode) {
    super(message);
    this.name = "GitHubWriteError";
    this.status = status;
    this.code = code;
  }
}

type CallInput = {
  repo: string;
  token: string;
  method: string;
  path: string;
  body?: unknown;
  options?: GitHubCallOptions;
};

type CallResult = {
  ok: boolean;
  status: number;
  body: unknown;
};

export async function getRef(
  repo: string,
  branch: string,
  token: string,
  options?: GitHubCallOptions,
): Promise<{ sha: string }> {
  const result = await githubOk({
    repo,
    token,
    method: "GET",
    path: `/repos/${repo}/git/refs/heads/${encodeGitPath(branch)}`,
    options,
  });
  const sha = objectSha(result);
  if (sha === undefined) throw new GitHubWriteError("GitHub response was missing a sha");
  return { sha };
}

export async function getFileBlobSha(
  repo: string,
  ref: string,
  path: string,
  token: string,
  options?: GitHubCallOptions,
): Promise<string> {
  const result = await readContents(repo, ref, path, token, options);
  if (typeof result.sha !== "string" || result.sha.length === 0) {
    throw new GitHubWriteError("GitHub response was missing a sha");
  }
  return result.sha;
}

export async function getFileText(
  repo: string,
  ref: string,
  path: string,
  token: string,
  options?: GitHubCallOptions,
): Promise<string> {
  const result = await readContents(repo, ref, path, token, options);
  if (typeof result.content !== "string" || result.encoding === "none") {
    throw new GitHubWriteError("GitHub file content was empty");
  }
  return Buffer.from(result.content.replaceAll(/\s/g, ""), "base64").toString("utf8");
}

/**
 * The regular file at `path` on `ref`, or null when it does not exist.
 * Rejects directories, symlinks, submodules, and responses for a different
 * path (the contents API follows symlinks to their target).
 */
export async function getFileEntry(
  repo: string,
  ref: string,
  path: string,
  token: string,
  options?: GitHubCallOptions,
): Promise<{ sha: string; text: string } | null> {
  const result = await githubCall({
    repo,
    token,
    method: "GET",
    path: `/repos/${repo}/contents/${encodeGitPath(path)}?ref=${encodeURIComponent(ref)}`,
    options,
  });
  if (result.status === 404) return null;
  if (!result.ok) throw httpError(result.status, result.body, token);
  const body = result.body;
  if (!isRecord(body) || body.type !== "file" || body.path !== path) {
    throw new GitHubWriteError("GitHub resource is not a regular file");
  }
  if (typeof body.sha !== "string" || body.sha.length === 0) {
    throw new GitHubWriteError("GitHub response was missing a sha");
  }
  if (typeof body.content !== "string" || body.encoding !== "base64") {
    throw new GitHubWriteError("GitHub file content was empty");
  }
  return { sha: body.sha, text: Buffer.from(body.content.replaceAll(/\s/g, ""), "base64").toString("utf8") };
}

/** Entry names directly under `path` on `ref`; empty when the directory does not exist. */
export async function listDirectory(
  repo: string,
  ref: string,
  path: string,
  token: string,
  options?: GitHubCallOptions,
): Promise<string[]> {
  const result = await githubCall({
    repo,
    token,
    method: "GET",
    path: `/repos/${repo}/contents/${encodeGitPath(path)}?ref=${encodeURIComponent(ref)}`,
    options,
  });
  if (result.status === 404) return [];
  if (!result.ok) throw httpError(result.status, result.body, token);
  if (!Array.isArray(result.body)) throw new GitHubWriteError("GitHub resource is not a directory");
  return result.body.flatMap((entry) => (isRecord(entry) && typeof entry.name === "string" ? [entry.name] : []));
}

/** Branch names starting with `prefix` (at most the first 100). */
export async function listBranches(
  repo: string,
  prefix: string,
  token: string,
  options?: GitHubCallOptions,
): Promise<string[]> {
  const result = await githubOk({
    repo,
    token,
    method: "GET",
    path: `/repos/${repo}/git/matching-refs/heads/${encodeGitPath(prefix)}?per_page=100`,
    options,
  });
  if (!Array.isArray(result)) throw new GitHubWriteError("GitHub ref list was unreadable");
  const names: string[] = [];
  for (const entry of result) {
    if (!isRecord(entry) || typeof entry.ref !== "string" || !entry.ref.startsWith("refs/heads/")) continue;
    names.push(entry.ref.slice("refs/heads/".length));
  }
  return names;
}

/** A text file (sent as UTF-8) or binary content already encoded as base64. */
export type CommitFile = { path: string; text: string } | { path: string; base64: string };

/**
 * Commit `files` on top of `baseSha` (a commit sha). Creates blobs, a tree
 * based on that commit's tree (`base_tree`), then a commit whose parent is
 * `baseSha`. Returns the new commit sha. Never force-updates a ref.
 */
export async function commitFiles(
  input: {
    repo: string;
    token: string;
    baseSha: string;
    files: readonly CommitFile[];
    message: string;
  },
  options?: GitHubCallOptions,
): Promise<string> {
  if (input.files.length === 0) throw new GitHubWriteError("no files to commit");
  const seen = new Set<string>();
  for (const file of input.files) {
    if (seen.has(file.path)) throw new GitHubWriteError(`duplicate path ${file.path}`);
    seen.add(file.path);
  }
  const parent = await githubOk({
    repo: input.repo,
    token: input.token,
    method: "GET",
    path: `/repos/${input.repo}/git/commits/${encodeURIComponent(input.baseSha)}`,
    options,
  });
  const treeSha = isRecord(parent) && isRecord(parent.tree) && typeof parent.tree.sha === "string"
    ? parent.tree.sha
    : undefined;
  if (treeSha === undefined) throw new GitHubWriteError("GitHub commit is missing a tree");

  const entries: { path: string; mode: "100644"; type: "blob"; sha: string }[] = [];
  for (const file of input.files) {
    const blob = await githubOk({
      repo: input.repo,
      token: input.token,
      method: "POST",
      path: `/repos/${input.repo}/git/blobs`,
      body: "base64" in file ? { content: file.base64, encoding: "base64" } : { content: file.text, encoding: "utf-8" },
      options,
    });
    const sha = isRecord(blob) && typeof blob.sha === "string" ? blob.sha : undefined;
    if (sha === undefined) throw new GitHubWriteError("GitHub response was missing a sha");
    entries.push({ path: file.path, mode: "100644", type: "blob", sha });
  }

  const tree = await githubOk({
    repo: input.repo,
    token: input.token,
    method: "POST",
    path: `/repos/${input.repo}/git/trees`,
    body: { base_tree: treeSha, tree: entries },
    options,
  });
  const newTree = isRecord(tree) && typeof tree.sha === "string" ? tree.sha : undefined;
  if (newTree === undefined) throw new GitHubWriteError("GitHub response was missing a sha");

  const commit = await githubOk({
    repo: input.repo,
    token: input.token,
    method: "POST",
    path: `/repos/${input.repo}/git/commits`,
    body: { message: input.message, tree: newTree, parents: [input.baseSha] },
    options,
  });
  const sha = isRecord(commit) && typeof commit.sha === "string" ? commit.sha : undefined;
  if (sha === undefined) throw new GitHubWriteError("GitHub response was missing a sha");
  return sha;
}

export async function createBranch(
  repo: string,
  name: string,
  sha: string,
  token: string,
  options?: GitHubCallOptions,
): Promise<void> {
  await githubOk({
    repo,
    token,
    method: "POST",
    path: `/repos/${repo}/git/refs`,
    body: { ref: `refs/heads/${name}`, sha },
    options,
  });
}

/**
 * Fast-forward `name` to `sha` only when it still points at `expectedOldSha`.
 * `force` is always false. A tip that already moved is "branch moved" (code
 * `branch_moved`). A refused update whose tip did not move (branch protection,
 * rulesets) is code `rejected`.
 */
export async function updateBranch(
  repo: string,
  name: string,
  sha: string,
  expectedOldSha: string,
  token: string,
  options?: GitHubCallOptions,
): Promise<void> {
  const path = `/repos/${repo}/git/refs/heads/${encodeGitPath(name)}`;
  const current = await githubCall({ repo, token, method: "GET", path, options });
  if (!current.ok) {
    throw current.status === 422
      ? new GitHubWriteError("branch moved", 422, "branch_moved")
      : httpError(current.status, current.body, token);
  }
  if (objectSha(current.body) !== expectedOldSha) {
    throw new GitHubWriteError("branch moved", 422, "branch_moved");
  }
  const updated = await githubCall({
    repo,
    token,
    method: "PATCH",
    path,
    body: { sha, force: false },
    options,
  });
  if (updated.ok) return;
  if (updated.status !== 403 && updated.status !== 409 && updated.status !== 422) {
    throw httpError(updated.status, updated.body, token);
  }
  // Tell a moved tip from a refusal: read the tip again.
  const after = await githubCall({ repo, token, method: "GET", path, options });
  if (after.ok && objectSha(after.body) === expectedOldSha) {
    const refused = httpError(updated.status, updated.body, token);
    throw new GitHubWriteError(refused.message, updated.status, "rejected");
  }
  throw new GitHubWriteError("branch moved", 422, "branch_moved");
}

export async function deleteBranch(
  repo: string,
  name: string,
  token: string,
  options?: GitHubCallOptions,
): Promise<void> {
  await githubOk({
    repo,
    token,
    method: "DELETE",
    path: `/repos/${repo}/git/refs/heads/${encodeGitPath(name)}`,
    options,
  });
}

export async function openPullRequest(
  input: {
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
    token: string;
  },
  options?: GitHubCallOptions,
): Promise<{ number: number; url: string }> {
  const result = await githubOk({
    repo: input.repo,
    token: input.token,
    method: "POST",
    path: `/repos/${input.repo}/pulls`,
    body: { title: input.title, head: input.head, base: input.base, body: input.body },
    options,
  });
  if (!isRecord(result) || typeof result.number !== "number" || typeof result.html_url !== "string") {
    throw new GitHubWriteError("GitHub pull request response was incomplete");
  }
  // The UI renders this as a link; only an https URL is passed through.
  return { number: result.number, url: httpsOr(result.html_url, `https://github.com/${input.repo}/pull/${result.number}`) };
}

function httpsOr(value: string, fallback: string): string {
  try {
    return new URL(value).protocol === "https:" ? value : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Adds `label` when that label already exists. Missing labels and any request
 * error are logged without the token and do not reject the caller.
 * Resolves true only when the label was applied.
 */
export async function addLabelBestEffort(
  repo: string,
  pr: number,
  label: string,
  token: string,
  options?: GitHubCallOptions,
): Promise<boolean> {
  try {
    const existing = await githubCall({
      repo,
      token,
      method: "GET",
      path: `/repos/${repo}/labels/${encodeURIComponent(label)}`,
      options,
    });
    if (existing.status === 404) return false;
    if (!existing.ok) {
      logLabelFailure(token, httpError(existing.status, existing.body, token));
      return false;
    }
    const added = await githubCall({
      repo,
      token,
      method: "POST",
      path: `/repos/${repo}/issues/${pr}/labels`,
      body: { labels: [label] },
      options,
    });
    if (!added.ok) {
      logLabelFailure(token, httpError(added.status, added.body, token));
      return false;
    }
    return true;
  } catch (error) {
    logLabelFailure(token, error);
    return false;
  }
}

async function readContents(
  repo: string,
  ref: string,
  path: string,
  token: string,
  options?: GitHubCallOptions,
): Promise<Record<string, unknown>> {
  const result = await githubOk({
    repo,
    token,
    method: "GET",
    path: `/repos/${repo}/contents/${encodeGitPath(path)}?ref=${encodeURIComponent(ref)}`,
    options,
  });
  if (!isRecord(result) || Array.isArray(result) || result.type === "dir") {
    throw new GitHubWriteError("GitHub resource is not a file");
  }
  return result;
}

async function githubOk(input: CallInput): Promise<unknown> {
  const result = await githubCall(input);
  if (result.ok) return result.body;
  throw httpError(result.status, result.body, input.token);
}

async function githubCall(input: CallInput): Promise<CallResult> {
  if (!REPO_PATTERN.test(input.repo)) throw new GitHubWriteError("invalid repository");
  const timeoutMs = input.options?.timeoutMs ?? GITHUB_WRITE_TIMEOUT_MS;
  const fetchImpl = input.options?.fetchImpl ?? fetch;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await settle(
      fetchImpl(`${GITHUB_API}${input.path}`, {
        method: input.method,
        headers: githubHeaders(input.token, input.body !== undefined),
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        redirect: "error",
        signal,
      }),
      signal,
    );
    return { ok: response.ok, status: response.status, body: await readBody(response) };
  } catch (error) {
    if (signal.aborted || isAbort(error)) {
      throw new GitHubWriteError("GitHub request timed out");
    }
    if (error instanceof GitHubWriteError) throw error;
    const message = error instanceof Error ? error.message : "GitHub request failed";
    throw new GitHubWriteError(scrub(message, input.token));
  }
}

function githubHeaders(token: string, json: boolean): Headers {
  const headers = new Headers();
  headers.set("Accept", "application/vnd.github+json");
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("User-Agent", "snoboard");
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  if (json) headers.set("Content-Type", "application/json");
  return headers;
}

// Bodies are parsed whole: file contents (base64) and ref lists are often far
// larger than a few KB. The cap only bounds memory.
const MAX_RESPONSE_CHARS = 8 * 1024 * 1024;

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  if (text.length > MAX_RESPONSE_CHARS) {
    if (response.ok) throw new GitHubWriteError("GitHub response was too large");
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (response.ok) throw new GitHubWriteError("GitHub returned an unreadable response");
    return undefined;
  }
}

function httpError(status: number, body: unknown, token: string): GitHubWriteError {
  const detail = recordMessage(body);
  const safe = detail === undefined ? "" : scrub(detail, token);
  const base = statusText(status);
  const message = safe.length > 0 && status !== 401 ? `${base}: ${safe}` : base;
  return new GitHubWriteError(message, status);
}

function statusText(status: number): string {
  if (status === 401) return "GitHub authentication failed (401)";
  if (status === 404) return "GitHub resource not found (404)";
  if (status === 409) return "GitHub request conflicted (409)";
  if (status === 422) return "GitHub rejected the request (422)";
  return `GitHub request failed (${status})`;
}

function objectSha(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (isRecord(value.object) && typeof value.object.sha === "string" && value.object.sha.length > 0) {
    return value.object.sha;
  }
  if (typeof value.sha === "string" && value.sha.length > 0) return value.sha;
  return undefined;
}

function recordMessage(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.message !== "string") return undefined;
  const message = value.message.trim();
  if (message.length === 0 || message.length > 300) return undefined;
  return message;
}

function logLabelFailure(token: string, error: unknown): void {
  const message = error instanceof Error ? error.message : "label request failed";
  console.error(`snoboard: could not add label: ${scrub(message, token)}`);
}

function scrub(message: string, token: string): string {
  if (token.length === 0) return message;
  return message.split(token).join("[redacted]");
}

function encodeGitPath(value: string): string {
  return value
    .split("/")
    .filter((part) => part.length > 0)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function settle<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
