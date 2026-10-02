import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildSnapshot,
  fetch as fetchRefs,
  loadConfig,
  type Config,
  type GitCallOptions,
  type Snapshot,
} from "snoboard";
import { EDIT_BRANCH_PREFIX } from "./edits/submit.js";
import { loadSyncSettings, type BoardEnv } from "./env.js";
import { githubTokenFromEnv } from "./forge/github.js";
import { loadProposals, setProposals } from "./proposals.js";
import { editSettingsFor, loadReposConfig, setActiveRepos, type RepoConfig } from "./repos-config.js";
import { commitSnapshot, DEFAULT_REPO_ID, recordSyncError, registerRepo, setRefreshing } from "./store.js";

export type Logger = {
  info(message: string): void;
  error(message: string): void;
};

export type RepoSyncOptions = {
  logger?: Logger;
  repoId?: string;
};

export type RepoSyncsOptions = {
  logger?: Logger;
  dataDir?: string;
  refreshSeconds?: number;
  /** Delay between starting each repository. The first starts immediately. */
  staggerMs?: number;
};

export type RepoSyncController = {
  readonly repoDir: string;
  requestRefresh(): Promise<void>;
  start(): void;
  stop(): void;
};

type GitResult = {
  code: number;
  stdout: string;
  stdoutBytes: Buffer;
  stderr: string;
};

const HELPER_SOURCE = [
  'import { readFileSync } from "node:fs";',
  "const tokenPath = process.argv[2];",
  "const action = process.argv[3];",
  'if (action !== "get" || tokenPath === undefined || tokenPath.length === 0) {',
  "  process.exit(0);",
  "}",
  'const token = readFileSync(tokenPath, "utf8").trim();',
  "if (token.length === 0) process.exit(0);",
  'process.stdout.write("username=x-access-token\\npassword=" + token + "\\n");',
  "",
].join("\n");

const defaultLogger: Logger = {
  info(message) {
    console.info(message);
  },
  error(message) {
    console.error(message);
  },
};

function shellQuote(value: string): string {
  return `"${value.replaceAll("\\", "/").replaceAll('"', '\\"')}"`;
}

export function sshCommandFor(keyPath: string): string {
  // OpenSSH writes known_hosts under the passwd home (not $HOME), which is
  // read-only in hardened containers; keep it next to the key instead.
  const knownHosts = path.join(path.dirname(keyPath), "known_hosts");
  return (
    `ssh -i ${shellQuote(keyPath)} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new ` +
    `-o UserKnownHostsFile=${shellQuote(knownHosts)} -o BatchMode=yes`
  );
}

function credentialHelperConfig(helperPath: string, tokenPath: string): string {
  return `!${shellQuote(process.execPath)} ${shellQuote(helperPath)} ${shellQuote(tokenPath)}`;
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** Public https clones must not require a credential helper. Token files still install one. */
export function cloneCredentialArgs(
  repoUrl: string,
  gitTokenFile: string | undefined,
  helperPath: string,
): readonly string[] {
  if (gitTokenFile !== undefined) {
    return ["-c", `credential.helper=${credentialHelperConfig(helperPath, gitTokenFile)}`];
  }
  if (isHttpUrl(repoUrl)) return ["-c", "credential.helper="];
  return [];
}

export function refspecsFor(config: Config): string[] {
  const specs = [
    `+refs/heads/${config.defaultBranch}:refs/remotes/origin/${config.defaultBranch}`,
  ];
  for (const pattern of config.branchPatterns) {
    const spec = `+refs/heads/${pattern}:refs/remotes/origin/${pattern}`;
    if (!specs.includes(spec)) specs.push(spec);
  }
  // Edit branches are fetched so proposals can be diffed, then hidden from the
  // snapshot so they never become ordinary initiative branches.
  const edits = `+refs/heads/${EDIT_BRANCH_PREFIX}*:refs/remotes/origin/${EDIT_BRANCH_PREFIX}*`;
  if (!specs.includes(edits)) specs.push(edits);
  return specs;
}

export function redactSecrets(message: string, secrets: readonly string[]): string {
  // Any URL userinfo is a credential: user:password@ and token-only (ghp_x@).
  let redacted = message.replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/\s@]+@/g, "$1[redacted]@");
  const unique = [...new Set(secrets.filter((secret) => secret.length >= 4))].sort(
    (left, right) => right.length - left.length,
  );
  for (const secret of unique) {
    redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted;
}

function spawnGit(
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["--no-pager", ...args], {
      cwd,
      windowsHide: true,
      env,
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
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      handler();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => {
        reject(new Error(`git ${args.join(" ")} timed out`));
      });
    }, 120_000);
    stdout.on("data", (chunk: Buffer | string) => {
      stdoutChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    stderr.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    child.on("error", (error) => {
      finish(() => {
        reject(error);
      });
    });
    child.on("close", (code) => {
      finish(() => {
        const bytes = Buffer.concat(stdoutChunks);
        resolve({
          code: code ?? 1,
          stdoutBytes: bytes,
          stdout: bytes.toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
        });
      });
    });
    stdin.end();
  });
}

function missingConfigBlob(message: string): boolean {
  return /does not exist|exists on disk, but not in|pathspec .* did not match/i.test(message);
}

class RepoSync implements RepoSyncController {
  readonly repoDir: string;
  private readonly repoId: string;
  private readonly logger: Logger;
  private readonly helperPath: string;
  private readonly hooksDir: string;
  private running = false;
  private pending = false;
  private stopped = false;
  private started = false;
  private waiters: Array<() => void> = [];
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly env: BoardEnv,
    options?: RepoSyncOptions,
  ) {
    this.repoId = options?.repoId ?? DEFAULT_REPO_ID;
    this.repoDir = path.join(env.dataDir, "repo");
    this.helperPath = path.join(env.dataDir, "git-credential-helper.mjs");
    this.hooksDir = path.join(env.dataDir, "hooks");
    this.logger = options?.logger ?? defaultLogger;
  }

  start(): void {
    if (this.stopped || this.started) return;
    this.started = true;
    void this.requestRefresh();
    this.timer = setInterval(() => {
      void this.requestRefresh();
    }, this.env.refreshSeconds * 1000);
    const timer = this.timer as { unref?: () => void };
    timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    this.pending = false;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    const waiters = this.waiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  requestRefresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const done = new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    this.pending = true;
    if (!this.running) void this.drain();
    return done;
  }

  private async drain(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    setRefreshing(true, this.repoId);
    try {
      while (this.pending && !this.stopped) {
        this.pending = false;
        await this.tick();
      }
    } finally {
      this.running = false;
      if (this.pending && !this.stopped) {
        void this.drain();
        return;
      }
      setRefreshing(false, this.repoId);
      const waiters = this.waiters.splice(0);
      for (const resolve of waiters) resolve();
    }
  }

  private gitEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "",
      GCM_INTERACTIVE: "Never",
    };
    if (this.env.sshKeyFile !== undefined) {
      env.GIT_SSH_COMMAND = sshCommandFor(this.sshKeyPath());
    }
    return env;
  }

  private coreGitEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { GCM_INTERACTIVE: "Never" };
    if (this.env.sshKeyFile !== undefined) env.GIT_SSH_COMMAND = sshCommandFor(this.sshKeyPath());
    return env;
  }

  private async git(args: readonly string[], cwd = this.repoDir): Promise<string> {
    const result = await spawnGit(cwd, args, this.gitEnv());
    if (result.code !== 0) {
      const detail = result.stderr.trim();
      throw new Error(`git ${args.join(" ")} failed (${result.code})${detail ? `: ${detail}` : ""}`);
    }
    return result.stdout;
  }

  private async readSecrets(): Promise<string[]> {
    const secrets: string[] = [];
    const userinfo = /:\/\/([^/\s@]+)@/.exec(this.env.repoUrl)?.[1];
    if (userinfo !== undefined) {
      secrets.push(userinfo);
      for (const part of userinfo.split(":")) secrets.push(part);
    }
    if (this.env.gitTokenFile !== undefined) {
      secrets.push(this.env.gitTokenFile);
      const token = (await readFile(this.env.gitTokenFile, "utf8")).trim();
      if (token.length > 0) secrets.push(token);
    }
    if (this.env.sshKeyFile !== undefined) {
      secrets.push(this.env.sshKeyFile);
      const key = await readFile(this.env.sshKeyFile, "utf8");
      if (key.trim().length > 0) secrets.push(key);
      for (const line of key.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.length >= 8) secrets.push(trimmed);
      }
    }
    return secrets;
  }

  private async hasClone(): Promise<boolean> {
    try {
      const gitDir = await stat(path.join(this.repoDir, ".git"));
      return gitDir.isDirectory();
    } catch {
      return false;
    }
  }

  /** The private copy of the SSH key that git actually uses (see prepareSshKey). */
  private sshKeyPath(): string {
    return path.join(this.env.dataDir, "ssh", "id_snoboard");
  }

  /**
   * OpenSSH ignores keys readable by group or others. Mounted secrets are
   * usually 0444 (or 0440 with fsGroup), so copy the key into the data dir
   * with mode 0600, owned by the process user.
   */
  private async prepareSshKey(): Promise<void> {
    if (this.env.sshKeyFile === undefined) return;
    const key = await readFile(this.env.sshKeyFile);
    if (key.length === 0) throw new Error("SNOBOARD_SSH_KEY_FILE is empty");
    const target = this.sshKeyPath();
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    // OpenSSH also rejects a private key without a trailing newline.
    const content = key.at(-1) === 0x0a ? key : Buffer.concat([key, Buffer.from("\n")]);
    await writeFile(target, content, { mode: 0o600 });
    await chmod(target, 0o600);
  }

  private async ensureClone(): Promise<void> {
    await mkdir(this.env.dataDir, { recursive: true });
    await this.prepareSshKey();
    await mkdir(this.hooksDir, { recursive: true });
    if (await this.hasClone()) return;
    await rm(this.repoDir, { recursive: true, force: true });
    const cloneArgs = [
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      "--no-tags",
      // Only the remote default branch at first; configureRefspecs() then
      // narrows fetches to the default branch plus branchPatterns.
      "--single-branch",
      this.env.repoUrl,
      this.repoDir,
    ];
    if (this.env.gitTokenFile !== undefined) {
      await writeFile(this.helperPath, HELPER_SOURCE, "utf8");
    }
    cloneArgs.unshift(
      ...cloneCredentialArgs(this.env.repoUrl, this.env.gitTokenFile, this.helperPath),
    );
    try {
      await this.git(cloneArgs, this.env.dataDir);
    } catch (error) {
      await rm(this.repoDir, { recursive: true, force: true });
      throw error;
    }
    this.logger.info("cloned repository");
  }

  private async configureGit(): Promise<void> {
    await this.git(["config", "core.hooksPath", this.hooksDir]);
    if (this.env.sshKeyFile !== undefined) {
      await this.git(["config", "core.sshCommand", sshCommandFor(this.sshKeyPath())]);
    }
    if (this.env.gitTokenFile === undefined) {
      // An empty helper clears inherited helpers so a public https fetch does not ask for credentials.
      if (isHttpUrl(this.env.repoUrl)) {
        await this.git(["config", "--local", "--replace-all", "credential.helper", ""]);
      }
      return;
    }
    await writeFile(this.helperPath, HELPER_SOURCE, "utf8");
    const helper = credentialHelperConfig(this.helperPath, this.env.gitTokenFile);
    await this.git(["config", "--local", "--replace-all", "credential.helper", ""]);
    await this.git(["config", "--local", "--add", "credential.helper", helper]);
  }

  private async remoteDefaultBranch(): Promise<string> {
    try {
      const ref = (await this.git(["symbolic-ref", "refs/remotes/origin/HEAD"])).trim();
      const prefix = "refs/remotes/origin/";
      if (ref.startsWith(prefix) && ref.length > prefix.length) return ref.slice(prefix.length);
    } catch {
      // Fall through to the abbreviated remote HEAD.
    }
    const short = (await this.git(["rev-parse", "--abbrev-ref", "origin/HEAD"])).trim();
    const name = short.startsWith("origin/") ? short.slice("origin/".length) : short;
    if (name.length === 0 || name === "HEAD") {
      throw new Error("Could not determine the remote default branch");
    }
    return name;
  }

  private async readConfig(): Promise<Config> {
    if (this.env.configPath !== undefined) {
      return loadConfig(await readFile(this.env.configPath, "utf8"));
    }
    const branch = await this.remoteDefaultBranch();
    try {
      const text = await this.git(["show", `origin/${branch}:.snoboard.yml`]);
      return loadConfig(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (missingConfigBlob(message)) return loadConfig();
      throw error;
    }
  }

  /**
   * `snoboard/edits-*` must be in the clone for proposals, but `listRefs` would
   * treat a matching branch pattern as a normal initiative branch and could
   * replace the card with the unmerged copy. Drop those refs for the snapshot,
   * then put them back.
   */
  private async snapshotWithoutEditBranches(
    config: Config,
    options: GitCallOptions,
  ): Promise<Snapshot> {
    const held = await this.listEditBranchRefs();
    const removed: { name: string; sha: string }[] = [];
    try {
      for (const ref of held) {
        await this.git(["update-ref", "-d", ref.name]);
        removed.push(ref);
      }
      return await buildSnapshot(this.repoDir, config, options);
    } finally {
      await this.restoreEditBranches(removed);
    }
  }

  private async listEditBranchRefs(): Promise<{ name: string; sha: string }[]> {
    const prefix = `refs/remotes/origin/${EDIT_BRANCH_PREFIX}`;
    // The pattern must be a glob: a name that does not end in `/` is an exact match.
    const listed = await this.git(["for-each-ref", "--format=%(objectname)%09%(refname)", `${prefix}*`]);
    const refs: { name: string; sha: string }[] = [];
    for (const line of listed.split(/\r?\n/)) {
      if (line.length === 0) continue;
      const tab = line.indexOf("\t");
      if (tab === -1) continue;
      const sha = line.slice(0, tab);
      const name = line.slice(tab + 1);
      if (!/^[0-9a-f]{40}$/.test(sha) || !name.startsWith(prefix)) continue;
      refs.push({ name, sha });
    }
    return refs;
  }

  private async restoreEditBranches(refs: readonly { name: string; sha: string }[]): Promise<void> {
    const errors: string[] = [];
    for (const ref of refs) {
      try {
        await this.git(["update-ref", ref.name, ref.sha]);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (errors.length > 0) throw new Error(errors.join("; "));
  }

  private async configureRefspecs(refspecs: readonly string[]): Promise<void> {
    const [first, ...rest] = refspecs;
    if (first === undefined) throw new Error("expected a default-branch refspec");
    await this.git(["config", "--replace-all", "remote.origin.fetch", first]);
    for (const spec of rest) {
      await this.git(["config", "--add", "remote.origin.fetch", spec]);
    }
  }

  private async tick(): Promise<void> {
    let secrets: string[] = [];
    try {
      secrets = await this.readSecrets();
      await this.ensureClone();
      await this.configureGit();
      const config = await this.readConfig();
      const refspecs = refspecsFor(config);
      await this.configureRefspecs(refspecs);
      // Core git calls must use the same SSH setup as clone; an inherited
      // GIT_SSH_COMMAND would otherwise override core.sshCommand.
      const gitOptions = { env: this.coreGitEnv() };
      await fetchRefs(this.repoDir, refspecs, gitOptions);
      const snapshot = await this.snapshotWithoutEditBranches(config, gitOptions);
      const settings = editSettingsFor(this.repoId);
      const proposals = await loadProposals({
        repoDir: this.repoDir,
        config,
        baseBranch: settings.baseBranch ?? config.defaultBranch,
        token: githubTokenFromEnv(),
        env: gitOptions.env,
      });
      commitSnapshot(snapshot, config, new Date().toISOString(), this.repoId);
      setProposals(proposals, this.repoId);
      this.logger.info("snapshot updated");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const redacted = redactSecrets(message, secrets);
      recordSyncError(redacted, new Date().toISOString(), this.repoId);
      this.logger.error(redacted);
    }
  }
}

let active: RepoSync | undefined;
let configured = false;
const repoDirOverrides = new Map<string, string>();
const syncs = new Map<string, RepoSync>();
const startTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DEFAULT_STAGGER_MS = 1000;

const COMMIT_SHA = /^[0-9a-f]{40}$/;

/** Tests point the body endpoint at a fixture checkout. Production uses the sync clone. */
export function setInitiativeRepoDir(dir: string | undefined, repoId = DEFAULT_REPO_ID): void {
  if (dir === undefined) repoDirOverrides.delete(repoId);
  else repoDirOverrides.set(repoId, dir);
}

export function initiativeRepoDir(repoId = DEFAULT_REPO_ID): string | undefined {
  const override = repoDirOverrides.get(repoId);
  if (override !== undefined) return override;
  return syncs.get(repoId)?.repoDir ?? (repoId === DEFAULT_REPO_ID ? active?.repoDir : undefined);
}

export function isRepoRelativePath(filePath: string): boolean {
  if (filePath.length === 0 || filePath.length > 512) return false;
  if (filePath.includes("\\") || filePath.includes("\0") || filePath.includes(":")) return false;
  if (filePath.startsWith("/")) return false;
  const parts = filePath.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

/** Raw blob text at `sha:path`, without checkout newline conversion. */
export async function readCommittedFile(repoDir: string, sha: string, filePath: string): Promise<string> {
  if (!COMMIT_SHA.test(sha) || !isRepoRelativePath(filePath)) {
    throw new Error("invalid git object");
  }
  const result = await spawnGit(
    repoDir,
    ["-c", "core.autocrlf=false", "show", "--no-textconv", `${sha}:${filePath}`],
    {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
    },
  );
  if (result.code !== 0) throw new Error("git show failed");
  return result.stdout;
}

/** Raw blob bytes at `sha:path`. Undefined when the object is missing, not a blob, or larger than `maxBytes`. */
export async function readCommittedBytes(
  repoDir: string,
  sha: string,
  filePath: string,
  maxBytes: number,
): Promise<Buffer | undefined> {
  if (!COMMIT_SHA.test(sha) || !isRepoRelativePath(filePath)) return undefined;
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" };
  const object = `${sha}:${filePath}`;
  // `cat-file -t` refuses trees and submodules; symlinks are blobs and fail the magic-byte check later.
  const kind = await spawnGit(repoDir, ["cat-file", "-t", object], env);
  if (kind.code !== 0 || kind.stdout.trim() !== "blob") return undefined;
  const size = await spawnGit(repoDir, ["cat-file", "-s", object], env);
  if (size.code !== 0 || !/^\d+$/.test(size.stdout.trim()) || Number(size.stdout.trim()) > maxBytes) return undefined;
  const result = await spawnGit(repoDir, ["cat-file", "blob", object], env);
  if (result.code !== 0) return undefined;
  return result.stdoutBytes;
}

export function createRepoSync(env: BoardEnv, options?: RepoSyncOptions): RepoSyncController {
  const repoId = options?.repoId ?? DEFAULT_REPO_ID;
  const previous = syncs.get(repoId);
  previous?.stop();
  if (repoId === DEFAULT_REPO_ID && active !== undefined && active !== previous) active.stop();
  const sync = new RepoSync(env, { ...options, repoId });
  syncs.set(repoId, sync);
  if (repoId === DEFAULT_REPO_ID) active = sync;
  registerRepo(repoId);
  return sync;
}

export function startRepoSync(env: BoardEnv, options?: RepoSyncOptions): RepoSyncController {
  const sync = createRepoSync(env, options);
  sync.start();
  return sync;
}

function stopManaged(): void {
  for (const timer of startTimers.values()) clearTimeout(timer);
  startTimers.clear();
  for (const sync of syncs.values()) sync.stop();
  syncs.clear();
  active = undefined;
}

function repoDataDir(root: string, id: string): string {
  if (!/^[a-z0-9-]{1,32}$/.test(id)) throw new Error(`Invalid repository id: ${id}`);
  const base = path.resolve(root);
  const dir = path.resolve(base, id);
  const relative = path.relative(base, dir);
  if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Invalid repository id: ${id}`);
  }
  return dir;
}

function boardEnvFor(repo: RepoConfig, root: string, refreshSeconds: number): BoardEnv {
  return {
    repoUrl: repo.url,
    dataDir: repoDataDir(root, repo.id),
    refreshSeconds,
    ...(repo.sshKeyFile === undefined ? {} : { sshKeyFile: repo.sshKeyFile }),
    ...(repo.gitTokenFile === undefined ? {} : { gitTokenFile: repo.gitTokenFile }),
    ...(repo.configPath === undefined ? {} : { configPath: repo.configPath }),
  };
}

function scheduleStart(sync: RepoSyncController, repoId: string, delay: number): void {
  if (delay <= 0) {
    sync.start();
    return;
  }
  const timer = setTimeout(() => {
    startTimers.delete(repoId);
    sync.start();
  }, delay);
  startTimers.set(repoId, timer);
  (timer as { unref?: () => void }).unref?.();
}

export function startRepoSyncs(repos: readonly RepoConfig[], options?: RepoSyncsOptions): RepoSyncController[] {
  stopManaged();
  const fallback =
    options?.dataDir !== undefined && options.refreshSeconds !== undefined
      ? undefined
      : loadSyncSettings(process.env);
  const dataDir = options?.dataDir ?? fallback?.dataDir ?? "/tmp/snoboard";
  const refreshSeconds = options?.refreshSeconds ?? fallback?.refreshSeconds ?? 120;
  for (const repo of repos) registerRepo(repo.id);
  const staggerMs = options?.staggerMs ?? DEFAULT_STAGGER_MS;
  return repos.map((repo, index) => {
    const sync = createRepoSync(boardEnvFor(repo, dataDir, refreshSeconds), {
      logger: options?.logger,
      repoId: repo.id,
    });
    const delay = index * staggerMs;
    scheduleStart(sync, repo.id, delay);
    if (delay <= 0) return sync;
    return {
      repoDir: sync.repoDir,
      requestRefresh: () => sync.requestRefresh(),
      start: () => sync.start(),
      stop: () => {
        const pending = startTimers.get(repo.id);
        if (pending !== undefined) clearTimeout(pending);
        startTimers.delete(repo.id);
        sync.stop();
      },
    };
  });
}

export function requestRefresh(repoId = DEFAULT_REPO_ID): Promise<void> {
  const sync = syncs.get(repoId) ?? (repoId === DEFAULT_REPO_ID ? active : undefined);
  if (sync === undefined) return Promise.resolve();
  return sync.requestRefresh();
}

export function startRepoSyncIfConfigured(): void {
  if (configured || process.env.VITEST === "true") return;
  const reposFile = process.env.SNOBOARD_REPOS_FILE?.trim() ?? "";
  const repoUrl = process.env.SNOBOARD_REPO_URL?.trim() ?? "";
  if (reposFile === "" && repoUrl === "") return;
  const repos = loadReposConfig(process.env);
  setActiveRepos(repos);
  const settings = loadSyncSettings(process.env);
  configured = true;
  startRepoSyncs(repos, settings);
}
