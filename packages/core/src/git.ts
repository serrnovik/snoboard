/// <reference types="node" />
import { spawn } from "node:child_process";

/**
 * Fields the reader needs from repository config.
 * A full config object is assignable to this shape.
 */
export interface GitConfig {
  root: string;
  file: string;
  defaultBranch: string;
  branchPatterns: readonly string[];
}

export interface RefInfo {
  name: string;
  sha: string;
  isDefault: boolean;
}

export interface InitiativeFile {
  path: string;
  blobSha: string;
}

export interface CommitTouch {
  sha: string;
  date: string;
}

/** Optional probe so tests can count git processes. */
export interface GitCallOptions {
  onSpawn?: (args: readonly string[]) => void;
  /** Milliseconds before the git process is killed. Defaults: 120 s, fetch 10 min. */
  timeoutMs?: number;
  /** Extra environment for git (e.g. GIT_SSH_COMMAND), layered over process.env. */
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const FETCH_TIMEOUT_MS = 600_000;

const DEFAULT_REMOTE = "origin";

interface GitResult {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
}

function runGit(
  repoDir: string,
  args: readonly string[],
  options?: GitCallOptions & { input?: Buffer; env?: NodeJS.ProcessEnv },
): Promise<GitResult> {
  options?.onSpawn?.(args);
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["--no-pager", ...args], {
      cwd: repoDir,
      windowsHide: true,
      env: {
        ...process.env,
        ...options?.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
        GCM_INTERACTIVE: "Never",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdout = child.stdout;
    const stderr = child.stderr;
    const stdin = child.stdin;
    if (stdout === null || stderr === null || stdin === null) {
      child.kill();
      reject(new Error("git stdio was not piped"));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const finish = (handler: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      handler();
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(() => {
        reject(new Error(`git ${args.join(" ")} timed out`));
      });
    }, options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    stdout.on("data", (chunk: Buffer | string) => {
      stdoutChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    stderr.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    stdin.on("error", () => {
      // git may exit before reading the batch request
    });
    child.on("error", (error) => {
      finish(() => {
        reject(error);
      });
    });
    child.on("close", (code) => {
      finish(() => {
        resolve({
          code: code ?? 1,
          stdout: Buffer.concat(stdoutChunks),
          stderr: Buffer.concat(stderrChunks),
        });
      });
    });

    if (options?.input !== undefined) {
      stdin.end(options.input);
    } else {
      stdin.end();
    }
  });
}

async function git(
  repoDir: string,
  args: readonly string[],
  options?: GitCallOptions & { input?: Buffer; env?: NodeJS.ProcessEnv },
): Promise<GitResult> {
  const result = await runGit(repoDir, args, options);
  if (result.code !== 0) {
    const detail = result.stderr.toString("utf8").trim();
    throw new Error(
      `git ${args.join(" ")} failed (${result.code})${detail ? `: ${detail}` : ""}`,
    );
  }
  return result;
}

function textLines(buffer: Buffer): string[] {
  return buffer
    .toString("utf8")
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
}

/**
 * `*` and `?` match across `/`, so `initiative/*` includes `initiative/a/phase-1`.
 */
function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (const char of pattern) {
    if (char === "*") {
      source += ".*";
    } else if (char === "?") {
      source += ".";
    } else if (/[.+^${}()|[\]\\]/.test(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  source += "$";
  return new RegExp(source);
}

function compareName(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

interface ListedRef {
  name: string;
  sha: string;
}

async function forEachRef(
  repoDir: string,
  prefix: string,
  options?: GitCallOptions,
): Promise<ListedRef[]> {
  const result = await git(
    repoDir,
    ["for-each-ref", "--format=%(objectname)%09%(refname)", prefix],
    options,
  );
  const refs: ListedRef[] = [];
  for (const line of textLines(result.stdout)) {
    const tab = line.indexOf("\t");
    if (tab === -1) {
      continue;
    }
    const sha = line.slice(0, tab);
    const refName = line.slice(tab + 1);
    if (!refName.startsWith(prefix)) {
      continue;
    }
    const name = refName.slice(prefix.length);
    if (name.length === 0 || name === "HEAD") {
      continue;
    }
    refs.push({ name, sha });
  }
  return refs;
}

export async function listRefs(
  repoDir: string,
  options: {
    remote?: string;
    defaultBranch: string;
    branchPatterns: readonly string[];
  } & GitCallOptions,
): Promise<RefInfo[]> {
  const remote = options.remote ?? DEFAULT_REMOTE;
  const remoteRefs = await forEachRef(repoDir, `refs/remotes/${remote}/`, options);
  const listed =
    remoteRefs.length > 0
      ? remoteRefs
      : await forEachRef(repoDir, "refs/heads/", options);
  const matchers = options.branchPatterns.map(globToRegExp);
  const refs: RefInfo[] = [];
  for (const ref of listed) {
    const isDefault = ref.name === options.defaultBranch;
    const matched = matchers.some((matcher) => matcher.test(ref.name));
    if (!isDefault && !matched) {
      continue;
    }
    refs.push({ name: ref.name, sha: ref.sha, isDefault });
  }
  refs.sort((left, right) => compareName(left.name, right.name));
  return refs;
}

function isInitiativePath(filePath: string, root: string, file: string): boolean {
  const parts = filePath.split("/");
  const rootParts = root.length === 0 ? [] : root.split("/");
  if (parts.length !== rootParts.length + 3) {
    return false;
  }
  for (let index = 0; index < rootParts.length; index += 1) {
    if (parts[index] !== rootParts[index]) {
      return false;
    }
  }
  const project = parts[rootParts.length] ?? "";
  const slug = parts[rootParts.length + 1] ?? "";
  const name = parts[rootParts.length + 2] ?? "";
  return project.length > 0 && slug.length > 0 && name === file;
}

export async function listInitiativeFiles(
  repoDir: string,
  ref: string,
  config: GitConfig,
  options?: GitCallOptions,
): Promise<InitiativeFile[]> {
  const root = config.root.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const args = ["ls-tree", "-r", "-z", ref];
  if (root.length > 0) {
    args.push("--", root);
  }
  const result = await git(repoDir, args, options);
  const files: InitiativeFile[] = [];
  for (const record of result.stdout.toString("utf8").split("\0")) {
    if (record.length === 0) {
      continue;
    }
    const tab = record.indexOf("\t");
    if (tab === -1) {
      continue;
    }
    const meta = record.slice(0, tab).replace(/\r$/, "");
    const filePath = record.slice(tab + 1).replace(/\\/g, "/");
    const blobSha = meta.split(" ")[2];
    if (blobSha === undefined || !isInitiativePath(filePath, root, config.file)) {
      continue;
    }
    files.push({ path: filePath, blobSha });
  }
  files.sort((left, right) => compareName(left.path, right.path));
  return files;
}

function parseCatFileBatch(buffer: Buffer): Map<string, string> {
  const blobs = new Map<string, string>();
  let offset = 0;
  while (offset < buffer.length) {
    const newline = buffer.indexOf(0x0a, offset);
    if (newline === -1) {
      break;
    }
    let header = buffer.toString("utf8", offset, newline);
    offset = newline + 1;
    if (header.endsWith("\r")) {
      header = header.slice(0, -1);
    }
    if (header.endsWith(" missing")) {
      throw new Error(`git cat-file --batch: object missing (${header})`);
    }
    const parts = header.split(" ");
    const sha = parts[0];
    const size = Number(parts[2]);
    if (sha === undefined || sha.length === 0 || !Number.isInteger(size) || size < 0) {
      throw new Error(`git cat-file --batch: unexpected header ${header}`);
    }
    const content = buffer.toString("utf8", offset, offset + size);
    blobs.set(sha, content);
    offset += size;
    if (buffer[offset] === 0x0a) {
      offset += 1;
    }
  }
  return blobs;
}

export async function readBlobs(
  repoDir: string,
  shas: readonly string[],
  options?: GitCallOptions,
): Promise<Map<string, string>> {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const sha of shas) {
    if (!seen.has(sha)) {
      seen.add(sha);
      unique.push(sha);
    }
  }
  const blobs = new Map<string, string>();
  if (unique.length === 0) {
    return blobs;
  }
  const result = await git(repoDir, ["cat-file", "--batch"], {
    ...options,
    input: Buffer.from(`${unique.join("\n")}\n`, "utf8"),
  });
  const parsed = parseCatFileBatch(result.stdout);
  for (const sha of unique) {
    const content = parsed.get(sha);
    if (content === undefined) {
      throw new Error(`git cat-file --batch did not return object ${sha}`);
    }
    blobs.set(sha, content);
  }
  return blobs;
}

export async function lastCommitTouching(
  repoDir: string,
  ref: string,
  filePath: string,
  options?: GitCallOptions,
): Promise<CommitTouch> {
  const result = await git(
    repoDir,
    ["log", "-1", "--format=%H%x09%cI", ref, "--", filePath],
    options,
  );
  const line = textLines(result.stdout)[0];
  if (line === undefined) {
    throw new Error(`No commit on ${ref} touches ${filePath}`);
  }
  const tab = line.indexOf("\t");
  if (tab === -1) {
    throw new Error("git log returned an unexpected line");
  }
  return { sha: line.slice(0, tab), date: line.slice(tab + 1).trim() };
}

/**
 * Paths under `root` that `refSha` changed since it forked from `baseSha`
 * (three-dot diff). Needs trees only, so it is safe in a blob-less clone.
 */
export async function changedSinceMergeBase(
  repoDir: string,
  baseSha: string,
  refSha: string,
  root: string,
  options?: GitCallOptions,
): Promise<Set<string>> {
  const result = await git(
    repoDir,
    // -z gives raw paths (no C-quoting), matching ls-tree -z output.
    ["diff", "-z", "--name-only", "--no-renames", `${baseSha}...${refSha}`, "--", root],
    options,
  );
  return new Set(
    result.stdout
      .toString("utf8")
      .split(" ")
      .filter((path) => path.length > 0),
  );
}

/**
 * Newest commit that touches each path under `root` at `ref`.
 * One `git log` walk; the first time a path appears wins.
 * Pass a commit SHA — a partial clone may have no local branch of that name.
 */
export async function lastCommitsForPaths(
  repoDir: string,
  ref: string,
  root: string,
  options?: GitCallOptions,
): Promise<Map<string, CommitTouch>> {
  const normalized = root.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  // Merge commits list no files by default; first-parent diffs attribute files
  // that arrived through a merge to that merge commit. quotePath=false keeps
  // non-ASCII paths unescaped so they match ls-tree output.
  const args = [
    "-c",
    "core.quotePath=false",
    "log",
    "--format=%x00%H%x09%cI",
    "--name-only",
    "--diff-merges=first-parent",
    // Walk the ref's own first-parent line: a file that arrived through a
    // merge is attributed to that merge, independent of commit-date ties and
    // of path-limited history simplification (which differs across Git
    // versions and can hide the merge).
    "--first-parent",
    // Rename detection reads blob contents, which in a blob:none partial clone
    // means one lazy network fetch per blob. Names-only needs trees alone.
    "--no-renames",
    ref,
  ];
  if (normalized.length > 0) {
    args.push("--", normalized);
  }
  const result = await git(repoDir, args, { ...options, env: { ...options?.env, GIT_NO_LAZY_FETCH: "1" } });
  return parseNameOnlyLog(result.stdout);
}

function parseNameOnlyLog(buffer: Buffer): Map<string, CommitTouch> {
  const touches = new Map<string, CommitTouch>();
  for (const record of buffer.toString("utf8").split("\0")) {
    let sha: string | undefined;
    let date: string | undefined;
    for (const line of record.split(/\r?\n/)) {
      if (line.length === 0) {
        continue;
      }
      if (sha === undefined || date === undefined) {
        const tab = line.indexOf("\t");
        if (tab === -1) {
          continue;
        }
        sha = line.slice(0, tab).trim();
        date = line.slice(tab + 1).trim();
        continue;
      }
      const filePath = line.replaceAll("\\", "/");
      if (sha.length > 0 && date.length > 0 && !touches.has(filePath)) {
        touches.set(filePath, { sha, date });
      }
    }
  }
  return touches;
}
export async function fetch(
  repoDir: string,
  refspecs: readonly string[],
  options?: GitCallOptions,
): Promise<void> {
  await git(
    repoDir,
    ["fetch", "--prune", "--filter=blob:none", DEFAULT_REMOTE, ...refspecs],
    { timeoutMs: FETCH_TIMEOUT_MS, ...options },
  );
}
/**
 * Partial clones (`--filter=blob:none`) fetch missing blobs lazily, one
 * request per object. That is slow and can time out, so fetch every missing
 * blob in one request first. A no-op for full clones.
 */
export async function prefetchMissingBlobs(
  repoDir: string,
  shas: readonly string[],
  options?: GitCallOptions & { remote?: string },
): Promise<number> {
  const unique = [...new Set(shas)];
  if (unique.length === 0) {
    return 0;
  }
  const missing = await findMissingObjects(repoDir, unique, options);
  if (missing.length === 0) {
    return 0;
  }
  // Object ids go on the command line (not --stdin, which needs Git 2.43+) in
  // chunks that stay well under command-line limits. This mirrors Git's own
  // promisor fetch: explicitly requested blobs are sent despite the filter,
  // and the filter keeps the fetch from pulling anything else.
  const CHUNK = 200;
  for (let start = 0; start < missing.length; start += CHUNK) {
    await git(
      repoDir,
      [
        "-c",
        "fetch.negotiationAlgorithm=noop",
        "fetch",
        options?.remote ?? DEFAULT_REMOTE,
        "--no-tags",
        "--no-write-fetch-head",
        "--recurse-submodules=no",
        "--filter=blob:none",
        ...missing.slice(start, start + CHUNK),
      ],
      { timeoutMs: FETCH_TIMEOUT_MS, ...options },
    );
  }
  return missing.length;
}

/**
 * Object ids that are not present locally, without triggering lazy fetches.
 * Newer Git reports "<oid> missing" from `cat-file --batch-check` when lazy
 * fetching is disabled; Git 2.39 (Debian bookworm) aborts instead. Fall back
 * to `rev-list --missing=print`, and if that fails too, treat every id as
 * missing (one batched fetch is still far cheaper than lazy per-blob fetches).
 */
async function findMissingObjects(
  repoDir: string,
  shas: readonly string[],
  options?: GitCallOptions,
): Promise<string[]> {
  const noLazy = { ...options?.env, GIT_NO_LAZY_FETCH: "1" };
  try {
    const check = await git(repoDir, ["cat-file", "--batch-check"], {
      ...options,
      env: noLazy,
      input: Buffer.from(`${shas.join("\n")}\n`, "utf8"),
    });
    return textLines(check.stdout)
      .filter((line) => line.endsWith(" missing"))
      .map((line) => line.split(" ")[0] ?? "")
      .filter((sha) => sha.length > 0);
  } catch {
    // Fall through to rev-list.
  }
  const missing: string[] = [];
  try {
    const CHUNK = 200;
    for (let start = 0; start < shas.length; start += CHUNK) {
      const listed = await git(
        repoDir,
        ["rev-list", "--objects", "--no-walk", "--missing=print", ...shas.slice(start, start + CHUNK)],
        { ...options, env: noLazy },
      );
      for (const line of textLines(listed.stdout)) {
        if (line.startsWith("?")) missing.push(line.slice(1).trim());
      }
    }
    return missing;
  } catch {
    return [...shas];
  }
}
