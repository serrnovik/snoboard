import { spawn } from "node:child_process";
import {
  bodyHash,
  listInitiativeFiles,
  parseInitiativeFile,
  prefetchMissingBlobs,
  readBlobs,
  type Config,
  type GitCallOptions,
  type InitiativeFrontmatter,
  type Phase,
} from "snoboard";
import { EDIT_BRANCH_PREFIX } from "./edits/submit.js";

export type ProposalField = {
  field: string;
  value: string;
};

export type Proposal = {
  branch: string;
  pr?: { number: number; url: string };
  initiativeId: string;
  fields: ProposalField[];
};

const MAX_EDIT_BRANCHES = 20;
const PULL_TIMEOUT_MS = 5_000;
const GIT_TIMEOUT_MS = 60_000;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

// Keyed by repository id; single-repo deployments use "default".
const current = new Map<string, Proposal[]>();

export function getProposals(repoId = "default"): Proposal[] {
  return current.get(repoId) ?? [];
}

export function setProposals(proposals: readonly Proposal[], repoId = "default"): void {
  current.set(repoId, proposals.map((proposal) => ({
    ...proposal,
    fields: proposal.fields.map((field) => ({ ...field })),
    ...(proposal.pr === undefined ? {} : { pr: { ...proposal.pr } }),
  })));
}

export function resetProposals(): void {
  current.clear();
}

type GitResult = {
  code: number;
  stdout: string;
  stderr: string;
};

type EditTip = {
  branch: string;
  sha: string;
};

/**
 * Diff each open `snoboard/edits-*` branch against the base. A branch that has
 * been merged (its initiative blobs match the base) contributes nothing, so
 * the proposed badge disappears on the next refresh.
 */
export async function loadProposals(input: {
  repoDir: string;
  config: Config;
  baseBranch: string;
  token?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<Proposal[]> {
  if (!safeRef(input.baseBranch)) return [];
  const baseSha = await resolveCommit(input.repoDir, input.baseBranch, input.env);
  if (baseSha === undefined) return [];
  const tips = await listEditTips(input.repoDir, input.env);
  const proposals: Proposal[] = [];
  for (const tip of tips) {
    const changes = await diffBranch(input.repoDir, input.config, baseSha, tip.sha, input.env);
    for (const change of changes) {
      proposals.push({ branch: tip.branch, initiativeId: change.initiativeId, fields: change.fields });
    }
  }
  const token = input.token?.trim() ?? "";
  if (token.length > 0 && proposals.length > 0) {
    const branches = [...new Set(proposals.map((proposal) => proposal.branch))];
    const pulls = new Map<string, { number: number; url: string }>();
    await mapPool(branches, 4, async (branch) => {
      const pull = await lookupEditPull(input.config.forge.repo, branch, token, input.fetchImpl ?? fetch);
      if (pull !== undefined) pulls.set(branch, pull);
    });
    for (const proposal of proposals) {
      const pull = pulls.get(proposal.branch);
      if (pull !== undefined) proposal.pr = pull;
    }
  }
  proposals.sort((left, right) => {
    const byBranch = left.branch.localeCompare(right.branch);
    if (byBranch !== 0) return byBranch;
    return left.initiativeId.localeCompare(right.initiativeId);
  });
  return proposals;
}

async function diffBranch(
  repoDir: string,
  config: Config,
  baseSha: string,
  branchSha: string,
  env: NodeJS.ProcessEnv | undefined,
): Promise<Array<{ initiativeId: string; fields: ProposalField[] }>> {
  const options: GitCallOptions = env === undefined ? {} : { env };
  const [baseFiles, branchFiles] = await Promise.all([
    listInitiativeFiles(repoDir, baseSha, config, options),
    listInitiativeFiles(repoDir, branchSha, config, options),
  ]);
  const baseByPath = new Map(baseFiles.map((file) => [file.path, file.blobSha]));
  const changed: { path: string; baseBlob?: string; branchBlob: string }[] = [];
  for (const file of branchFiles) {
    const baseBlob = baseByPath.get(file.path);
    if (baseBlob === file.blobSha) continue;
    changed.push({
      path: file.path,
      ...(baseBlob === undefined ? {} : { baseBlob }),
      branchBlob: file.blobSha,
    });
  }
  if (changed.length === 0) return [];
  const shas = changed.flatMap((file) => (file.baseBlob === undefined ? [file.branchBlob] : [file.baseBlob, file.branchBlob]));
  if (await hasOrigin(repoDir, env)) {
    await prefetchMissingBlobs(repoDir, shas, { ...options, remote: "origin" });
  }
  const blobs = await readBlobs(repoDir, shas, options);
  const proposals: Array<{ initiativeId: string; fields: ProposalField[] }> = [];
  for (const file of changed) {
    const nextText = blobs.get(file.branchBlob);
    if (nextText === undefined) continue;
    const next = parseInitiativeFile(file.path, nextText, config);
    if (next.kind !== "initiative") continue;
    const baseText = file.baseBlob === undefined ? undefined : blobs.get(file.baseBlob);
    const baseParsed = baseText === undefined ? undefined : parseInitiativeFile(file.path, baseText, config);
    const base = baseParsed?.kind === "initiative" ? baseParsed.frontmatter : undefined;
    const fields = changedFields(base, next.frontmatter, baseText, nextText);
    if (fields.length === 0) continue;
    proposals.push({ initiativeId: next.frontmatter.id, fields });
  }
  return proposals;
}

function changedFields(
  base: InitiativeFrontmatter | undefined,
  next: InitiativeFrontmatter,
  baseText: string | undefined,
  nextText: string,
): ProposalField[] {
  if (base === undefined) {
    return [
      { field: "title", value: next.title },
      { field: "status", value: next.status },
      { field: "priority", value: next.priority },
    ];
  }
  const fields: ProposalField[] = [];
  if (base.title !== next.title) fields.push({ field: "title", value: next.title });
  if (base.status !== next.status) fields.push({ field: "status", value: next.status });
  if (base.priority !== next.priority) fields.push({ field: "priority", value: next.priority });
  if (!sameList(base.labels ?? [], next.labels ?? [])) {
    const labels = next.labels ?? [];
    fields.push({ field: "labels", value: labels.length === 0 ? "(none)" : labels.join(", ") });
  }
  if (!sameList(base.depends_on, next.depends_on)) {
    fields.push({
      field: "depends_on",
      value: next.depends_on.length === 0 ? "(none)" : next.depends_on.join(", "),
    });
  }
  fields.push(...phaseFields(base.phases, next.phases));
  if (baseText !== undefined && bodyHash(baseText) !== bodyHash(nextText)) {
    fields.push({ field: "body", value: "updated" });
  }
  return fields;
}

function phaseFields(base: readonly Phase[] | undefined, next: readonly Phase[] | undefined): ProposalField[] {
  const previous = new Map((base ?? []).map((phase) => [phase.id, phase]));
  const fields: ProposalField[] = [];
  for (const phase of next ?? []) {
    const before = previous.get(phase.id);
    if (before === undefined || before.status !== phase.status) {
      fields.push({ field: `phase ${phase.id}`, value: phase.status });
    }
  }
  return fields;
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

async function listEditTips(repoDir: string, env: NodeJS.ProcessEnv | undefined): Promise<EditTip[]> {
  const remote = await listNamedRefs(repoDir, "refs/remotes/origin/", env);
  const source = remote.length > 0 ? remote : await listNamedRefs(repoDir, "refs/heads/", env);
  return source
    .filter((ref) => ref.name.startsWith(EDIT_BRANCH_PREFIX))
    .map((ref) => ({ branch: ref.name, sha: ref.sha }))
    .sort((left, right) => right.branch.localeCompare(left.branch))
    .slice(0, MAX_EDIT_BRANCHES);
}

async function listNamedRefs(
  repoDir: string,
  prefix: string,
  env: NodeJS.ProcessEnv | undefined,
): Promise<{ name: string; sha: string }[]> {
  const result = await runGit(repoDir, ["for-each-ref", "--format=%(objectname)%09%(refname)", prefix], env);
  if (result.code !== 0) return [];
  const refs: { name: string; sha: string }[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const sha = line.slice(0, tab);
    const refName = line.slice(tab + 1);
    if (!SHA_PATTERN.test(sha) || !refName.startsWith(prefix)) continue;
    const name = refName.slice(prefix.length);
    if (name.length === 0 || name === "HEAD") continue;
    refs.push({ name, sha });
  }
  return refs;
}

async function hasOrigin(repoDir: string, env: NodeJS.ProcessEnv | undefined): Promise<boolean> {
  const result = await runGit(repoDir, ["remote"], env);
  if (result.code !== 0) return false;
  return result.stdout.split(/\r?\n/).includes("origin");
}

async function resolveCommit(
  repoDir: string,
  branch: string,
  env: NodeJS.ProcessEnv | undefined,
): Promise<string | undefined> {
  for (const ref of [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`]) {
    const result = await runGit(repoDir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], env);
    const sha = result.stdout.trim();
    if (result.code === 0 && SHA_PATTERN.test(sha)) return sha;
  }
  return undefined;
}

async function lookupEditPull(
  repo: string,
  branch: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<{ number: number; url: string } | undefined> {
  if (!REPO_PATTERN.test(repo)) return undefined;
  const owner = repo.slice(0, repo.indexOf("/"));
  const url = new URL(`https://api.github.com/repos/${repo}/pulls`);
  url.searchParams.set("state", "open");
  url.searchParams.set("per_page", "1");
  url.searchParams.set("head", `${owner}:${branch}`);
  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "snoboard",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(PULL_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    if (!Array.isArray(body) || body.length === 0) return undefined;
    const pull = body[0];
    if (typeof pull !== "object" || pull === null) return undefined;
    const record = pull as Record<string, unknown>;
    const number = record.number;
    if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) return undefined;
    const fallback = `https://github.com/${repo}/pull/${number}`;
    const html = typeof record.html_url === "string" ? record.html_url : fallback;
    return { number, url: httpsUrl(html, fallback) };
  } catch {
    return undefined;
  }
}

function httpsUrl(value: string, fallback: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return url.toString();
  } catch {
    return fallback;
  }
  return fallback;
}

function safeRef(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    !/[\s\\]/.test(name) &&
    !name.includes("..") &&
    !name.startsWith("-") &&
    !name.startsWith("/")
  );
}

async function mapPool<T>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0 || concurrency <= 0) return;
  let index = 0;
  async function run(): Promise<void> {
    for (;;) {
      const currentIndex = index;
      index += 1;
      if (currentIndex >= items.length) return;
      const item = items[currentIndex];
      if (item === undefined) return;
      await worker(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
}

function runGit(repoDir: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["--no-pager", ...args], {
      cwd: repoDir,
      windowsHide: true,
      env: {
        ...process.env,
        ...env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
        GCM_INTERACTIVE: "Never",
      },
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
    }, GIT_TIMEOUT_MS);
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
