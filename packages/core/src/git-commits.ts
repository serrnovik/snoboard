/// <reference types="node" />
import { spawn } from "node:child_process";
import type { GitCallOptions } from "./git.js";

export interface FileChange {
  status: string;
  path: string;
}

export interface CommitWithFiles {
  sha: string;
  date: string;
  authorName: string;
  authorEmail: string;
  /** Full message, capped. Trailers live here. */
  body: string;
  files: FileChange[];
}

/** Hard cap on commits read by one `commitsUnder` walk. */
export const MAX_ROOT_COMMITS = 5000;
const MAX_FIELD = 200;
const MAX_BODY_CHARS = 4000;
const RS = String.fromCharCode(0x1e);
const US = String.fromCharCode(0x1f);
const BACKSLASH = String.fromCharCode(92);

/**
 * Commits on `ref` touching `root`, newest first, with author, message and
 * `--name-status` file list. Commit metadata and trees only: no rename
 * detection, GIT_NO_LAZY_FETCH, bounded by `maxCount`.
 */
export async function commitsUnder(
  repoDir: string,
  ref: string,
  root: string,
  maxCount: number = MAX_ROOT_COMMITS,
  options?: GitCallOptions,
): Promise<CommitWithFiles[]> {
  const normalized = root.split(BACKSLASH).join("/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (ref.length === 0 || ref.startsWith("-")) throw new Error("invalid ref");
  const count = Math.max(1, Math.min(MAX_ROOT_COMMITS, Math.floor(maxCount)));
  const args = [
    "--no-pager",
    "-c",
    "core.quotePath=false",
    "log",
    "--no-renames",
    "--no-show-signature",
    "--name-status",
    `--max-count=${count}`,
    "--format=%x1e%H%x1f%cI%x1f%an%x1f%ae%x1f%B%x1f",
    ref,
  ];
  if (normalized.length > 0) args.push("--", normalized);
  options?.onSpawn?.(args.slice(1));
  const stdout = await run(repoDir, args, options);
  const commits: CommitWithFiles[] = [];
  for (const record of stdout.split(RS)) {
    const fields = record.split(US);
    if (fields.length < 6) continue;
    const [sha, date, authorName, authorEmail, body, changes] = fields as [string, string, string, string, string, string];
    if (!/^[0-9a-f]{40,64}$/.test(sha)) continue;
    const files: FileChange[] = [];
    for (const line of changes.split(/\r?\n/)) {
      const tab = line.indexOf("\t");
      if (tab <= 0) continue;
      files.push({ status: line.slice(0, tab).trim(), path: line.slice(tab + 1).split(BACKSLASH).join("/") });
    }
    commits.push({
      sha,
      date: date.trim(),
      authorName: authorName.slice(0, MAX_FIELD),
      authorEmail: authorEmail.slice(0, MAX_FIELD),
      body: body.slice(0, MAX_BODY_CHARS),
      files,
    });
  }
  return commits;
}

function run(repoDir: string, args: readonly string[], options?: GitCallOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...args], {
      cwd: repoDir,
      windowsHide: true,
      env: {
        ...process.env,
        ...options?.env,
        GIT_NO_LAZY_FETCH: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
        GCM_INTERACTIVE: "Never",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("git log timed out"));
    }, options?.timeoutMs ?? 120_000);
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`git log failed (${code}): ${Buffer.concat(err).toString("utf8").trim()}`));
        return;
      }
      resolve(Buffer.concat(out).toString("utf8"));
    });
  });
}
