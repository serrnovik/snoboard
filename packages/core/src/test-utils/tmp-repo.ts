/// <reference types="node" />
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface TmpRepoCommit {
  /** Branch to commit on. Defaults to the repository default branch. */
  branch?: string;
  files: Readonly<Record<string, string>>;
  message?: string;
  /** Author and committer date passed to git (ISO-8601). */
  date?: string;
}

export interface TmpRepo {
  dir: string;
  defaultBranch: string;
  tips: Map<string, string>;
  commit(commit: TmpRepoCommit): Promise<string>;
  remove(): Promise<void>;
}

export interface BareRepo {
  dir: string;
  remove(): Promise<void>;
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runGit(
  repoDir: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["--no-pager", ...args], {
      cwd: repoDir,
      windowsHide: true,
      env: env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (stdout === null || stderr === null) {
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
    }, 60_000);
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
  });
}

async function git(
  repoDir: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await runGit(repoDir, args, env);
  if (result.code !== 0) {
    const detail = result.stderr.trim();
    throw new Error(
      `git ${args.join(" ")} failed (${result.code})${detail ? `: ${detail}` : ""}`,
    );
  }
  return result.stdout;
}

async function removeDir(dir: string): Promise<void> {
  let lastError: unknown = new Error(`failed to remove ${dir}`);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => {
        setTimeout(resolve, 50 * (attempt + 1));
      });
    }
  }
  throw lastError;
}

function relativeParts(filePath: string): string[] {
  if (path.isAbsolute(filePath) || /^[A-Za-z]:/.test(filePath)) {
    throw new Error(`Expected a repository-relative path: ${filePath}`);
  }
  const parts = filePath.split(/[/\\]/).filter((part) => part.length > 0);
  if (parts.some((part) => part === "." || part === "..")) {
    throw new Error(`Path must stay inside the repository: ${filePath}`);
  }
  return parts;
}

async function refExists(repoDir: string, ref: string): Promise<boolean> {
  const result = await runGit(repoDir, ["show-ref", "--verify", "--quiet", ref]);
  return result.code === 0;
}

async function commitFiles(
  repoDir: string,
  defaultBranch: string,
  commit: TmpRepoCommit,
): Promise<string> {
  const branch = commit.branch ?? defaultBranch;
  if (
    branch !== defaultBranch &&
    !(await refExists(repoDir, `refs/heads/${defaultBranch}`))
  ) {
    throw new Error("Commit to the default branch before creating other branches");
  }
  const current = (await git(repoDir, ["branch", "--show-current"])).trim();
  if (current !== branch) {
    const exists = await refExists(repoDir, `refs/heads/${branch}`);
    if (exists) {
      await git(repoDir, ["switch", branch]);
    } else {
      await git(repoDir, ["switch", "-c", branch, defaultBranch]);
    }
  }

  const paths: string[] = [];
  for (const [relativePath, content] of Object.entries(commit.files)) {
    const parts = relativeParts(relativePath);
    const fullPath = path.join(repoDir, ...parts);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf8");
    paths.push(parts.join("/"));
  }
  if (paths.length === 0) {
    throw new Error("A commit needs at least one file");
  }
  const chunkSize = 80;
  for (let index = 0; index < paths.length; index += chunkSize) {
    await git(repoDir, ["add", "--", ...paths.slice(index, index + chunkSize)]);
  }

  const env = { ...process.env };
  if (commit.date !== undefined) {
    env.GIT_AUTHOR_DATE = commit.date;
    env.GIT_COMMITTER_DATE = commit.date;
  } else {
    delete env.GIT_AUTHOR_DATE;
    delete env.GIT_COMMITTER_DATE;
  }
  await git(repoDir, ["commit", "-m", commit.message ?? "test commit"], env);
  return (await git(repoDir, ["rev-parse", "HEAD"])).trim();
}

export async function createTmpRepo(options?: {
  defaultBranch?: string;
  commits?: readonly TmpRepoCommit[];
}): Promise<TmpRepo> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "snoboard-repo-"));
  const defaultBranch = options?.defaultBranch ?? "main";
  const tips = new Map<string, string>();
  try {
    await git(dir, ["init", "-b", defaultBranch]);
    await git(dir, ["config", "user.email", "snoboard@example.com"]);
    await git(dir, ["config", "user.name", "Snoboard Tests"]);
    await git(dir, ["config", "commit.gpgsign", "false"]);
    await git(dir, ["config", "core.autocrlf", "false"]);
    await git(dir, ["config", "core.safecrlf", "false"]);
    const hooksDir = path.join(dir, ".git", "snoboard-hooks");
    await mkdir(hooksDir, { recursive: true });
    await git(dir, ["config", "core.hooksPath", hooksDir]);
    for (const entry of options?.commits ?? []) {
      const branch = entry.branch ?? defaultBranch;
      tips.set(branch, await commitFiles(dir, defaultBranch, entry));
    }
  } catch (error) {
    await removeDir(dir);
    throw error;
  }

  return {
    dir,
    defaultBranch,
    tips,
    async commit(entry: TmpRepoCommit): Promise<string> {
      const branch = entry.branch ?? defaultBranch;
      const sha = await commitFiles(dir, defaultBranch, entry);
      tips.set(branch, sha);
      return sha;
    },
    remove: () => removeDir(dir),
  };
}

export async function createBareClone(sourceDir: string): Promise<BareRepo> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "snoboard-bare-"));
  const dir = path.join(parent, "repo.git");
  try {
    await git(parent, ["clone", "--bare", sourceDir, dir]);
    await git(dir, ["config", "uploadpack.allowFilter", "true"]);
  } catch (error) {
    await removeDir(parent);
    throw error;
  }
  return {
    dir,
    remove: () => removeDir(parent),
  };
}

export async function addRemote(
  repoDir: string,
  url: string,
  name = "origin",
): Promise<void> {
  const remoteUrl = path.isAbsolute(url) ? url.replace(/\\/g, "/") : url;
  await git(repoDir, ["remote", "add", name, remoteUrl]);
}