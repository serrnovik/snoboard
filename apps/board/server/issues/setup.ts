import { createHash } from "node:crypto";
import { issueLinkFor, parseIssueRef } from "snoboard";
import { githubTokenFromEnv } from "../forge/github.js";
import { findActiveRepo, listActiveRepos, type RepoConfig } from "../repos-config.js";
import { DEFAULT_REPO_ID, getConfig } from "../store.js";
import { createGithubIssueProvider } from "./github.js";
import { createIssueRegistry, ISSUE_CACHE_TTL_MS, type IssueRegistry } from "./registry.js";
import type { IssueProvider, IssueRef, IssueState } from "./provider.js";
import { createVikunjaProvider, vikunjaBase } from "./vikunja.js";

/** Link on a card. `title` and `state` are present only when a fresh cached state exists. */
export type BoardIssueLink = {
  raw: string;
  url: string;
  title?: string;
  state?: IssueState["state"];
  updatedAt?: string;
};

type Slot = {
  signature: string;
  registry: IssueRegistry;
};

type MemoryEntry = {
  expires: number;
  value: IssueState;
};

type ParsedEntry = {
  raw: string;
  ref?: IssueRef;
};

const slots = new Map<string, Slot>();
const remembered = new Map<string, MemoryEntry>();

/** Test hook: number of cached issue states across repositories. */
export function rememberedIssueCount(): number {
  return remembered.size;
}

export function resetIssueSetup(): void {
  slots.clear();
  remembered.clear();
}

function blank(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function readForgeRepo(repoId: string): string | undefined {
  return blank(getConfig(repoId)?.forge.repo);
}

function sameRepoName(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/**
 * A single-repo board (env, id `default`, or a one-entry file without `issues`)
 * reads GitHub from `forge.repo` when the shared read token is configured.
 * A multi-repo file enables a provider only from that entry's `issues` block.
 */
function implicitGithub(repoId: string, repo: RepoConfig | undefined): boolean {
  if (repo?.issues !== undefined) return false;
  if (githubTokenFromEnv() === undefined) return false;
  const catalog = listActiveRepos();
  if (catalog.length === 0) return repoId === DEFAULT_REPO_ID;
  if (catalog.length !== 1) return false;
  const only = catalog[0];
  return only?.id === repoId && only.issues === undefined;
}

function githubProvider(repoId: string, repo: RepoConfig | undefined, forgeRepo: string | undefined): IssueProvider | undefined {
  const configured = blank(repo?.issues?.github?.repo);
  if (configured === undefined && !implicitGithub(repoId, repo)) return undefined;
  const defaultRepo = configured ?? forgeRepo;
  if (defaultRepo === undefined) return undefined;
  // The provider sends this token only for `defaultRepo`. That must be the
  // repository's own forge repo; a different `issues.github.repo` is read anonymously.
  const token =
    forgeRepo === undefined || sameRepoName(defaultRepo, forgeRepo) ? githubTokenFromEnv() : undefined;
  return createGithubIssueProvider({
    defaultRepo,
    ...(token === undefined ? {} : { token }),
  });
}

function providersFor(repoId: string): IssueProvider[] {
  const repo = findActiveRepo(repoId);
  const forgeRepo = readForgeRepo(repoId);
  const providers: IssueProvider[] = [];
  const github = githubProvider(repoId, repo, forgeRepo);
  if (github !== undefined) providers.push(github);
  const vikunja = repo?.issues?.vikunja;
  if (vikunja !== undefined) {
    providers.push(
      createVikunjaProvider({
        baseUrl: vikunja.baseUrl,
        ...(vikunja.tokenFile === undefined ? {} : { tokenFile: vikunja.tokenFile }),
      }),
    );
  }
  return providers;
}

function signatureFor(repoId: string): string {
  const repo = findActiveRepo(repoId);
  return JSON.stringify({
    github: repo?.issues?.github?.repo ?? null,
    vikunja: repo?.issues?.vikunja ?? null,
    forge: readForgeRepo(repoId) ?? null,
    tokenFile: blank(process.env.SNOBOARD_GITHUB_TOKEN_FILE) ?? null,
    // A rotated or revoked token at the same path rebuilds the providers.
    token: tokenFingerprint(),
    catalog: listActiveRepos().map((entry) => ({
      id: entry.id,
      issues: entry.issues === undefined ? null : entry.issues,
    })),
  });
}

function tokenFingerprint(): string | null {
  const token = githubTokenFromEnv();
  if (token === undefined) return null;
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

function evictExpired(now: number): void {
  for (const [key, entry] of remembered) {
    if (entry.expires <= now) remembered.delete(key);
  }
}

function clearRemembered(repoId: string): void {
  const prefix = `${repoId}\n`;
  for (const key of remembered.keys()) {
    if (key.startsWith(prefix)) remembered.delete(key);
  }
}

function slotFor(repoId: string): Slot {
  const signature = signatureFor(repoId);
  const existing = slots.get(repoId);
  if (existing !== undefined && existing.signature === signature) return existing;
  clearRemembered(repoId);
  const created = { signature, registry: createIssueRegistry(providersFor(repoId)) };
  slots.set(repoId, created);
  return created;
}

function memoryKey(repoId: string, raw: string): string {
  return `${repoId}\n${raw}`;
}

function remember(repoId: string, states: Map<string, IssueState>): void {
  const now = Date.now();
  evictExpired(now);
  const expires = now + ISSUE_CACHE_TTL_MS;
  for (const state of states.values()) {
    const key = memoryKey(repoId, state.raw);
    if (state.state !== "open" && state.state !== "closed") {
      remembered.delete(key);
      continue;
    }
    remembered.set(key, { expires, value: state });
  }
}

function rememberedState(repoId: string, raw: string): IssueState | undefined {
  const entry = remembered.get(memoryKey(repoId, raw));
  if (entry === undefined) return undefined;
  if (entry.expires <= Date.now()) {
    remembered.delete(memoryKey(repoId, raw));
    return undefined;
  }
  return entry.value;
}

function parseRefs(rawRefs: readonly string[] | undefined): ParsedEntry[] {
  if (rawRefs === undefined) return [];
  return rawRefs.map((raw) => {
    const parsed = parseIssueRef(raw);
    if (parsed === undefined) return { raw };
    return { raw, ref: { provider: parsed.provider, key: parsed.key, raw: parsed.raw } };
  });
}

/** Provider link, else one built from the repo's public link config (works without tokens). */
function linkOf(repoId: string, slot: Slot, entry: ParsedEntry): string {
  if (entry.ref === undefined) return "";
  return slot.registry.linkFor(entry.ref) ?? issueLinkFor(entry.raw, issueLinkConfig(repoId));
}

function unknownIssue(raw: string, url = ""): IssueState {
  return { raw, title: "", state: "unknown", url };
}

/**
 * Card payload. Uses `linkFor` and states already fetched for this repo.
 * Does not call trackers, so a cold cache does not slow the board.
 */
export function boardIssueLinks(repoId: string, rawRefs: readonly string[] | undefined): BoardIssueLink[] {
  const entries = parseRefs(rawRefs);
  if (entries.length === 0) return [];
  const slot = slotFor(repoId);
  return entries.map((entry) => {
    const url = linkOf(repoId, slot, entry);
    const cached = rememberedState(repoId, entry.raw);
    if (cached === undefined) return { raw: entry.raw, url };
    return {
      raw: cached.raw,
      url: cached.url.length > 0 ? cached.url : url,
      title: cached.title,
      state: cached.state,
      ...(cached.updatedAt === undefined ? {} : { updatedAt: cached.updatedAt }),
    };
  });
}

/** Details payload. Fetches through the registry budget; failures are `unknown`. */
export async function fetchInitiativeIssues(
  repoId: string,
  rawRefs: readonly string[] | undefined,
): Promise<IssueState[]> {
  const entries = parseRefs(rawRefs);
  if (entries.length === 0) return [];
  const slot = slotFor(repoId);
  try {
    const states = await slot.registry.fetchStates(entries.flatMap((entry) => (entry.ref === undefined ? [] : [entry.ref])));
    remember(repoId, states);
    return entries.map((entry) => {
      const url = linkOf(repoId, slot, entry);
      if (entry.ref === undefined) return unknownIssue(entry.raw, url);
      const state = states.get(entry.raw);
      if (state === undefined) return unknownIssue(entry.raw, url);
      return state.url.length > 0 || url.length === 0 ? state : { ...state, url };
    });
  } catch {
    return entries.map((entry) => {
      const url = linkOf(repoId, slot, entry);
      return unknownIssue(entry.raw, url);
    });
  }
}

const OWNER_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Public link settings for the client (no tokens): Vikunja site and the GitHub repo `gh#n` means. */
export function issueLinkConfig(repoId: string): { vikunjaBaseUrl?: string; githubRepo?: string } {
  const repo = findActiveRepo(repoId);
  const configured = blank(repo?.issues?.github?.repo);
  const forge = readForgeRepo(repoId);
  const github = configured ?? (forge !== undefined && forge !== "owner/name" ? forge : undefined);
  const vikunja = repo?.issues?.vikunja === undefined ? undefined : vikunjaBase(repo.issues.vikunja.baseUrl.trim());
  return {
    ...(vikunja === undefined ? {} : { vikunjaBaseUrl: vikunja }),
    ...(github !== undefined && OWNER_NAME.test(github) ? { githubRepo: github } : {}),
  };
}
