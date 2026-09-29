import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildSnapshot, fetch as fetchRefs, loadConfig, type Config } from "snoboard";
import { loadBoardEnv, type BoardEnv } from "./env.js";
import { commitSnapshot, recordSyncError, setRefreshing } from "./store.js";

export type Logger = {
  info(message: string): void;
  error(message: string): void;
};

export type RepoSyncOptions = {
  logger?: Logger;
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
  return `ssh -i ${shellQuote(keyPath)} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
}

function credentialHelperConfig(helperPath: string, tokenPath: string): string {
  return `!${shellQuote(process.execPath)} ${shellQuote(helperPath)} ${shellQuote(tokenPath)}`;
}

export function refspecsFor(config: Config): string[] {
  const specs = [
    `+refs/heads/${config.defaultBranch}:refs/remotes/origin/${config.defaultBranch}`,
  ];
  for (const pattern of config.branchPatterns) {
    const spec = `+refs/heads/${pattern}:refs/remotes/origin/${pattern}`;
    if (!specs.includes(spec)) specs.push(spec);
  }
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
        resolve({
          code: code ?? 1,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
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
  private readonly logger: Logger;
  private readonly helperPath: string;
  private readonly hooksDir: string;
  private running = false;
  private pending = false;
  private stopped = false;
  private waiters: Array<() => void> = [];
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly env: BoardEnv,
    options?: RepoSyncOptions,
  ) {
    this.repoDir = path.join(env.dataDir, "repo");
    this.helperPath = path.join(env.dataDir, "git-credential-helper.mjs");
    this.hooksDir = path.join(env.dataDir, "hooks");
    this.logger = options?.logger ?? defaultLogger;
  }

  start(): void {
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
    setRefreshing(true);
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
      setRefreshing(false);
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
      cloneArgs.unshift(
        "-c",
        `credential.helper=${credentialHelperConfig(this.helperPath, this.env.gitTokenFile)}`,
      );
    }
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
    if (this.env.gitTokenFile === undefined) return;
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
      const snapshot = await buildSnapshot(this.repoDir, config, gitOptions);
      commitSnapshot(snapshot, config, new Date().toISOString());
      this.logger.info("snapshot updated");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const redacted = redactSecrets(message, secrets);
      recordSyncError(redacted, new Date().toISOString());
      this.logger.error(redacted);
    }
  }
}

let active: RepoSync | undefined;
let configured = false;

export function createRepoSync(env: BoardEnv, options?: RepoSyncOptions): RepoSyncController {
  active?.stop();
  active = new RepoSync(env, options);
  return active;
}

export function startRepoSync(env: BoardEnv, options?: RepoSyncOptions): RepoSyncController {
  const sync = createRepoSync(env, options);
  sync.start();
  return sync;
}

export function requestRefresh(): Promise<void> {
  if (active === undefined) return Promise.resolve();
  return active.requestRefresh();
}

export function startRepoSyncIfConfigured(): void {
  if (configured || process.env.VITEST === "true") return;
  if (process.env.SNOBOARD_REPO_URL === undefined || process.env.SNOBOARD_REPO_URL.trim() === "") {
    return;
  }
  configured = true;
  startRepoSync(loadBoardEnv(process.env));
}
