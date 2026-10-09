import { readFileSync, statSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import {
  disabledEditSettings,
  editSettingsForRepo,
  getEditConfig,
  loadEditConfig,
  parseBranchPatterns,
  type EditMode,
  type EditSettings,
} from "./edit-env.js";
import { loadBoardEnv } from "./env.js";
import { forgejoBase, forgejoRepo } from "./issues/forgejo.js";
import { vikunjaBase } from "./issues/vikunja.js";

const REPO_ID = /^[a-z0-9-]{1,32}$/;

const SINGLE_REPO_ENV = [
  "SNOBOARD_REPO_URL",
  "SNOBOARD_SSH_KEY_FILE",
  "SNOBOARD_GIT_TOKEN_FILE",
  "SNOBOARD_CONFIG_PATH",
  "SNOBOARD_EDIT_MODES",
  "SNOBOARD_EDIT_BASE_BRANCH",
  "SNOBOARD_EDIT_DIRECT_BRANCH",
  "SNOBOARD_EDIT_DIRECT_BRANCHES",
  "SNOBOARD_EDIT_BOT_TOKEN_FILE",
  "SNOBOARD_BRANCH_LIST_PATTERNS",
] as const;

export type RepoEditConfig = {
  modes: EditMode[];
  baseBranch?: string;
  directBranch?: string;
  /** Branches `direct` may push to from a single-branch view. Default: only `directBranch`. */
  directBranches?: string[];
  botTokenFile?: string;
  /** OAuth write scope for GitHub users; `public_repo` for public repos. Default: SNOBOARD_GITHUB_WRITE_SCOPE. */
  githubWriteScope?: "repo" | "public_repo";
};

/** Accepted and stored. Issue sync is later work. */
export type RepoIssuesConfig = {
  github?: { repo: string };
  /** Without `tokenFile`, refs link to the site and state stays unknown (no API calls). */
  /** `projectId` (with a token) lets the board create tasks in that project. */
  /** `projectId` (default) and `projectMap` (initiative project -> Vikunja project), with a token, let the board create tasks. */
  vikunja?: { baseUrl: string; tokenFile?: string; projectId?: number; projectMap?: Record<string, number> };
  /** `fj#n` means `repo` on `baseUrl`. Without `tokenFile`, refs only link (no API calls). */
  forgejo?: { baseUrl: string; repo: string; tokenFile?: string };
};

export type RepoConfig = {
  id: string;
  name: string;
  url: string;
  sshKeyFile?: string;
  gitTokenFile?: string;
  configPath?: string;
  /** Remote branches offered in the branch picker (glob). Default `["*"]`; the newest 500 are listed. */
  branchListPatterns?: string[];
  edit: RepoEditConfig;
  issues?: RepoIssuesConfig;
};

const EditSchema = z
  .object({
    modes: z.array(z.enum(["pr", "direct"])).optional(),
    baseBranch: z.string().min(1).optional(),
    directBranch: z.string().min(1).optional(),
    directBranches: z.array(z.string().min(1)).max(100).optional(),
    botTokenFile: z.string().min(1).optional(),
    githubWriteScope: z.enum(["repo", "public_repo"]).optional(),
  })
  .strict();

const IssuesSchema = z
  .object({
    github: z
      .object({
        repo: z.string().min(1),
      })
      .strict()
      .optional(),
    vikunja: z
      .object({
        baseUrl: z.string().min(1),
        tokenFile: z.string().min(1).optional(),
        projectId: z.number().int().positive().optional(),
        projectMap: z.record(z.string().min(1).max(64), z.number().int().positive()).optional(),
      })
      .strict()
      .optional(),
    forgejo: z
      .object({
        baseUrl: z.string().min(1),
        repo: z.string().min(1),
        tokenFile: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const RepoSchema = z
  .object({
    id: z.string().regex(REPO_ID, "must match [a-z0-9-]{1,32}"),
    name: z.string().min(1).max(120),
    url: z.string().min(1),
    sshKeyFile: z.string().min(1).optional(),
    gitTokenFile: z.string().min(1).optional(),
    configPath: z.string().min(1).optional(),
    branchListPatterns: z.array(z.string().min(1)).min(1).max(100).optional(),
    edit: EditSchema.optional(),
    issues: IssuesSchema.optional(),
  })
  .strict();

const ReposFileSchema = z
  .object({
    repos: z.array(RepoSchema).min(1),
  })
  .strict();

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "repos";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

function blank(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function invalid(message: string): never {
  throw new Error(`Invalid Snoboard repos config: ${message}`);
}

/** `git@host:path`, `ssh://`, and `git+ssh://` need a deploy key. https may omit one. */
export function isSshRepoUrl(url: string): boolean {
  const lower = url.toLowerCase();
  if (lower.startsWith("ssh://") || lower.startsWith("git+ssh://")) return true;
  if (lower.includes("://")) return false;
  return /^[^/\s@:]+@[^/\s:]+:\S+$/.test(url);
}

function assertNoEmbeddedCredentials(url: string, label: string): void {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/\s@]+)@/i.exec(url);
  if (match === null) return;
  const scheme = match[1]?.toLowerCase() ?? "";
  const userinfo = match[2] ?? "";
  if (userinfo.includes(":") || scheme === "http" || scheme === "https") {
    invalid(`${label} must not contain credentials; use sshKeyFile or gitTokenFile`);
  }
}

function assertKeyFile(file: string): void {
  let isFile = false;
  try {
    isFile = statSync(file).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) invalid(`missing key file: ${file}`);
}

function assertCredentials(repo: { url: string; sshKeyFile?: string; gitTokenFile?: string }): void {
  assertNoEmbeddedCredentials(repo.url, "repository URL");
  if (repo.sshKeyFile !== undefined) assertKeyFile(repo.sshKeyFile);
  if (repo.gitTokenFile !== undefined) assertKeyFile(repo.gitTokenFile);
  if (isSshRepoUrl(repo.url) && repo.sshKeyFile === undefined) {
    invalid("SSH repository URL requires sshKeyFile");
  }
}

function editFromEnv(env: NodeJS.ProcessEnv): RepoEditConfig {
  const settings = loadEditConfig(env);
  const directBranch = blank(env.SNOBOARD_EDIT_DIRECT_BRANCH);
  const botTokenFile = blank(env.SNOBOARD_EDIT_BOT_TOKEN_FILE);
  return {
    modes: [...settings.modes],
    ...(settings.baseBranch === undefined ? {} : { baseBranch: settings.baseBranch }),
    ...(directBranch === undefined ? {} : { directBranch }),
    ...(settings.directBranches === undefined ? {} : { directBranches: [...settings.directBranches] }),
    ...(botTokenFile === undefined ? {} : { botTokenFile }),
  };
}

function editFromYaml(edit: z.infer<typeof EditSchema> | undefined): RepoEditConfig {
  if (edit === undefined) return { modes: [] };
  try {
    const parsed = editFromEnv({
      SNOBOARD_EDIT_MODES: (edit.modes ?? []).join(","),
      SNOBOARD_EDIT_BASE_BRANCH: edit.baseBranch,
      SNOBOARD_EDIT_DIRECT_BRANCH: edit.directBranch,
      SNOBOARD_EDIT_BOT_TOKEN_FILE: edit.botTokenFile,
    });
    if (edit.directBranches !== undefined && parsed.modes.includes("direct")) {
      parsed.directBranches = parseBranchPatterns(edit.directBranches, "edit.directBranches") ?? [];
    }
    return edit.githubWriteScope === undefined ? parsed : { ...parsed, githubWriteScope: edit.githubWriteScope };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    invalid(message);
  }
}

function repoFromEnv(env: NodeJS.ProcessEnv): RepoConfig {
  const board = loadBoardEnv(env);
  const repo: RepoConfig = {
    id: "default",
    name: "default",
    url: board.repoUrl,
    ...(board.sshKeyFile === undefined ? {} : { sshKeyFile: board.sshKeyFile }),
    ...(board.gitTokenFile === undefined ? {} : { gitTokenFile: board.gitTokenFile }),
    ...(board.configPath === undefined ? {} : { configPath: board.configPath }),
    ...branchListFrom(env.SNOBOARD_BRANCH_LIST_PATTERNS),
    edit: editFromEnv(env),
  };
  assertCredentials(repo);
  return repo;
}

function branchListFrom(raw: string | readonly string[] | undefined): { branchListPatterns?: string[] } {
  try {
    const patterns = parseBranchPatterns(raw, "branchListPatterns");
    return patterns === undefined || patterns.length === 0 ? {} : { branchListPatterns: patterns };
  } catch (error) {
    invalid(error instanceof Error ? error.message : String(error));
  }
}

/** Default branch-picker patterns: every remote branch. */
export const DEFAULT_BRANCH_LIST_PATTERNS: readonly string[] = ["*"];

function warnIfSingleRepoEnv(env: NodeJS.ProcessEnv): void {
  const set = SINGLE_REPO_ENV.filter((name) => blank(env[name]) !== undefined);
  if (set.length === 0) return;
  console.warn(`SNOBOARD_REPOS_FILE is set; ignoring single-repo settings: ${set.join(", ")}`);
}

function reposFromFile(file: string): RepoConfig[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    invalid(`cannot read SNOBOARD_REPOS_FILE (${message})`);
  }
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    invalid(message);
  }
  const result = ReposFileSchema.safeParse(parsed);
  if (!result.success) invalid(formatIssues(result.error));
  const seen = new Set<string>();
  return result.data.repos.map((entry) => {
    if (seen.has(entry.id)) invalid(`duplicate repository id: ${entry.id}`);
    seen.add(entry.id);
    const name = entry.name.trim();
    const url = entry.url.trim();
    if (name.length === 0) invalid("name is empty");
    if (url.length === 0) invalid("url is empty");
    const issues = entry.issues;
    if (issues?.vikunja !== undefined) {
      assertNoEmbeddedCredentials(issues.vikunja.baseUrl, "vikunja baseUrl");
      if (vikunjaBase(issues.vikunja.baseUrl) === undefined) {
        invalid("vikunja baseUrl must be an https URL (http only for localhost)");
      }
    }
    if (issues?.forgejo !== undefined) {
      assertNoEmbeddedCredentials(issues.forgejo.baseUrl, "forgejo baseUrl");
      if (forgejoBase(issues.forgejo.baseUrl) === undefined) {
        invalid("forgejo baseUrl must be an https URL (http only for localhost)");
      }
      if (forgejoRepo(issues.forgejo.repo) === undefined) invalid("forgejo repo must be owner/name");
    }
    const repo: RepoConfig = {
      id: entry.id,
      name,
      url,
      ...(entry.sshKeyFile === undefined ? {} : { sshKeyFile: entry.sshKeyFile }),
      ...(entry.gitTokenFile === undefined ? {} : { gitTokenFile: entry.gitTokenFile }),
      ...(entry.configPath === undefined ? {} : { configPath: entry.configPath }),
      ...branchListFrom(entry.branchListPatterns),
      edit: editFromYaml(entry.edit),
      ...(issues === undefined ? {} : { issues }),
    };
    assertCredentials(repo);
    return repo;
  });
}

/** YAML file when `SNOBOARD_REPOS_FILE` is set; otherwise one `default` repo from the single-repo env. */
export function loadReposConfig(env: NodeJS.ProcessEnv): RepoConfig[] {
  const file = blank(env.SNOBOARD_REPOS_FILE);
  if (file === undefined) return [repoFromEnv(env)];
  warnIfSingleRepoEnv(env);
  return reposFromFile(file);
}

let activeRepos: RepoConfig[] | null = null;

function cloneRepo(repo: RepoConfig): RepoConfig {
  return {
    id: repo.id,
    name: repo.name,
    url: repo.url,
    ...(repo.sshKeyFile === undefined ? {} : { sshKeyFile: repo.sshKeyFile }),
    ...(repo.gitTokenFile === undefined ? {} : { gitTokenFile: repo.gitTokenFile }),
    ...(repo.configPath === undefined ? {} : { configPath: repo.configPath }),
    ...(repo.branchListPatterns === undefined ? {} : { branchListPatterns: [...repo.branchListPatterns] }),
    edit: {
      modes: [...repo.edit.modes],
      ...(repo.edit.baseBranch === undefined ? {} : { baseBranch: repo.edit.baseBranch }),
      ...(repo.edit.directBranch === undefined ? {} : { directBranch: repo.edit.directBranch }),
      ...(repo.edit.directBranches === undefined ? {} : { directBranches: [...repo.edit.directBranches] }),
      ...(repo.edit.botTokenFile === undefined ? {} : { botTokenFile: repo.edit.botTokenFile }),
      ...(repo.edit.githubWriteScope === undefined ? {} : { githubWriteScope: repo.edit.githubWriteScope }),
    },
    ...(repo.issues === undefined ? {} : { issues: repo.issues }),
  };
}

/** Repositories the API serves. Unset until boot (or a test) publishes a catalog. */
export function setActiveRepos(repos: readonly RepoConfig[]): void {
  activeRepos = repos.map((repo) => cloneRepo(repo));
}

export function resetActiveRepos(): void {
  activeRepos = null;
}

export function listActiveRepos(): readonly RepoConfig[] {
  return activeRepos ?? [];
}

export function findActiveRepo(id: string): RepoConfig | undefined {
  return activeRepos?.find((repo) => repo.id === id);
}

/**
 * Edit settings for one repository. A configured catalog is the only source;
 * the process-wide single-repo settings apply only to `default` when no
 * catalog is published (tests and legacy boot). Unknown ids are read-only.
 */
export function editSettingsFor(repoId: string): EditSettings {
  if (activeRepos !== null) {
    const repo = findActiveRepo(repoId);
    return repo === undefined ? disabledEditSettings() : editSettingsForRepo(repo.edit);
  }
  return repoId === "default" ? getEditConfig() : disabledEditSettings();
}

/** Branch-picker patterns for one repository (`["*"]` unless configured). */
export function branchListPatternsFor(repoId: string, env: NodeJS.ProcessEnv = process.env): readonly string[] {
  if (activeRepos !== null) return findActiveRepo(repoId)?.branchListPatterns ?? DEFAULT_BRANCH_LIST_PATTERNS;
  if (repoId !== "default") return DEFAULT_BRANCH_LIST_PATTERNS;
  return branchListFrom(env.SNOBOARD_BRANCH_LIST_PATTERNS).branchListPatterns ?? DEFAULT_BRANCH_LIST_PATTERNS;
}

/**
 * Bot token file for one repository. Never falls back to another repo's bot:
 * with a catalog, only that repo's own `edit.botTokenFile` counts.
 */
export function botTokenFileFor(repoId: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (activeRepos !== null) return findActiveRepo(repoId)?.edit.botTokenFile;
  return repoId === "default" ? blank(env.SNOBOARD_EDIT_BOT_TOKEN_FILE) : undefined;
}
