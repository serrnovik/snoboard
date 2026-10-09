import {
  buildSnapshot,
  isValidBranchName,
  matchesBranchPatterns,
  type Config,
  type Snapshot,
} from "snoboard";

/** Newest branches the picker lists. */
export const MAX_LISTED_BRANCHES = 500;
/** Remote heads fetched for the list at most (names only come from `ls-remote`). */
export const MAX_FETCHED_BRANCHES = 2000;
/** Single-branch snapshots kept in memory per repository (least recently used is evicted). */
export const MAX_BRANCH_SNAPSHOTS = 8;
/** A branch the list does not know triggers one early list refresh, at most this often. */
const MISS_REFRESH_MS = 15_000;
const FETCH_CHUNK = 100;

/** Local namespace for heads fetched for the list or a branch view. Never read by the merged snapshot. */
export const BRANCH_REF_PREFIX = "refs/snoboard/heads/";

export type BranchInfo = { name: string; sha: string; date: string };

export type BranchList = {
  defaultBranch: string;
  branches: BranchInfo[];
  /** True when more branches matched than were listed. */
  truncated: boolean;
};

export type BranchSnapshot = { name: string; sha: string; snapshot: Snapshot };

export class BranchNotFoundError extends Error {
  constructor() {
    super("branch not found");
  }
}

/** What the API needs from a repository to show one branch. Tests register a fake. */
export interface BranchSource {
  list(): Promise<BranchList>;
  /** Snapshot of `name` alone. Throws BranchNotFoundError when the remote has no such branch. */
  snapshot(name: string): Promise<BranchSnapshot>;
  /** Drop the cached snapshot, e.g. after a submit pushed to the branch. */
  forget(name: string): void;
}

const sources = new Map<string, BranchSource>();

export function setBranchSource(repoId: string, source: BranchSource | undefined): void {
  if (source === undefined) sources.delete(repoId);
  else sources.set(repoId, source);
}

export function branchSource(repoId: string): BranchSource | undefined {
  return sources.get(repoId);
}

export type GitRunner = (args: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => Promise<string>;

export type GitBranchSourceOptions = {
  repoDir: string;
  git: GitRunner;
  /** Serialises fetches with the periodic sync so two fetches never race in one clone. */
  withLock: <T>(task: () => Promise<T>) => Promise<T>;
  config: () => Config | null;
  patterns: () => readonly string[];
  ttlMs: number;
  /** Extra env for snapshot git calls (SSH command). GIT_NO_LAZY_FETCH is always added. */
  env?: NodeJS.ProcessEnv;
  now?: () => number;
};

type RemoteHeads = { at: number; heads: Map<string, string> };

/** `<sha>\trefs/heads/<name>` lines; invalid names are dropped, never passed to git. */
export function parseLsRemote(text: string): Map<string, string> {
  const heads = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{40,64})\trefs\/heads\/(.+)$/.exec(line);
    if (match === null) continue;
    const [, sha, name] = match as unknown as [string, string, string];
    if (isValidBranchName(name)) heads.set(name, sha);
  }
  return heads;
}

/** `for-each-ref` output, already sorted newest first by git. */
export function parseBranchRefs(text: string, prefix = BRANCH_REF_PREFIX): BranchInfo[] {
  const branches: BranchInfo[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [sha, date, ref] = line.split("\t");
    if (sha === undefined || date === undefined || ref === undefined) continue;
    if (!/^[0-9a-f]{40,64}$/.test(sha) || !ref.startsWith(prefix)) continue;
    const name = ref.slice(prefix.length);
    if (!isValidBranchName(name)) continue;
    branches.push({ name, sha, date });
  }
  return branches;
}

/** Newest first; equal dates by name. */
export function sortBranches(branches: readonly BranchInfo[]): BranchInfo[] {
  return [...branches].sort((left, right) => {
    const byDate = Date.parse(right.date) - Date.parse(left.date);
    if (!Number.isNaN(byDate) && byDate !== 0) return byDate;
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });
}

/** Case-insensitive substring filter for `?q=`. */
export function filterBranches(branches: readonly BranchInfo[], query: string): BranchInfo[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...branches];
  return branches.filter((branch) => branch.name.toLowerCase().includes(needle));
}

/**
 * Branch list and single-branch snapshots from the sync clone. Heads are fetched with
 * `--filter=blob:none` into `refs/snoboard/heads/*` (commits and trees only); a branch
 * view then reads just the initiative blobs it needs. Every other git call runs with
 * GIT_NO_LAZY_FETCH so nothing quietly goes to the network.
 */
export function createGitBranchSource(options: GitBranchSourceOptions): BranchSource {
  const now = options.now ?? Date.now;
  const snapshots = new Map<string, { at: number; value: BranchSnapshot }>();
  let remote: RemoteHeads | undefined;
  let listed: { at: number; value: BranchList } | undefined;
  let pendingList: Promise<BranchList> | undefined;
  const noLazy = { ...options.env, GIT_NO_LAZY_FETCH: "1" };

  async function lsRemote(): Promise<Map<string, string>> {
    const text = await options.git(["ls-remote", "--heads", "origin"]);
    return parseLsRemote(text);
  }

  async function localHeads(): Promise<Map<string, string>> {
    const text = await options.git(["for-each-ref", "--format=%(objectname)%09%(refname)", BRANCH_REF_PREFIX], {
      env: noLazy,
    });
    const heads = new Map<string, string>();
    for (const line of text.split(/\r?\n/)) {
      const [sha, ref] = line.split("\t");
      if (sha === undefined || ref === undefined || !ref.startsWith(BRANCH_REF_PREFIX)) continue;
      heads.set(ref.slice(BRANCH_REF_PREFIX.length), sha);
    }
    return heads;
  }

  async function fetchHeads(names: readonly string[]): Promise<void> {
    for (let start = 0; start < names.length; start += FETCH_CHUNK) {
      const specs = names
        .slice(start, start + FETCH_CHUNK)
        .filter((name) => isValidBranchName(name))
        .map((name) => `+refs/heads/${name}:${BRANCH_REF_PREFIX}${name}`);
      if (specs.length === 0) continue;
      await options.git([
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--recurse-submodules=no",
        "--filter=blob:none",
        "origin",
        ...specs,
      ]);
    }
  }

  async function deleteHeads(names: readonly string[]): Promise<void> {
    for (const name of names) {
      if (!isValidBranchName(name)) continue;
      await options.git(["update-ref", "-d", `${BRANCH_REF_PREFIX}${name}`]);
    }
  }

  async function refreshList(): Promise<BranchList> {
    return options.withLock(async () => {
      const config = options.config();
      if (config === null) throw new Error("snapshot not ready");
      const heads = await lsRemote();
      remote = { at: now(), heads };
      const patterns = options.patterns();
      const wanted = [...heads.keys()]
        .filter((name) => name === config.defaultBranch || matchesBranchPatterns(name, patterns))
        .sort();
      const truncatedFetch = wanted.length > MAX_FETCHED_BRANCHES;
      const keep = new Set(wanted.slice(0, MAX_FETCHED_BRANCHES));
      const local = await localHeads();
      const stale = [...local.keys()].filter((name) => !heads.has(name));
      await deleteHeads(stale);
      const missing = [...keep].filter((name) => local.get(name) !== heads.get(name));
      await fetchHeads(missing);
      const text = await options.git(
        [
          "for-each-ref",
          "--sort=-committerdate",
          "--format=%(objectname)%09%(committerdate:iso-strict)%09%(refname)",
          BRANCH_REF_PREFIX,
        ],
        { env: noLazy },
      );
      const all = sortBranches(parseBranchRefs(text).filter((branch) => keep.has(branch.name)));
      const value: BranchList = {
        defaultBranch: config.defaultBranch,
        branches: all.slice(0, MAX_LISTED_BRANCHES),
        truncated: truncatedFetch || all.length > MAX_LISTED_BRANCHES,
      };
      listed = { at: now(), value };
      return value;
    });
  }

  async function list(): Promise<BranchList> {
    if (listed !== undefined && now() - listed.at < options.ttlMs) return listed.value;
    if (pendingList === undefined) {
      pendingList = refreshList().finally(() => {
        pendingList = undefined;
      });
    }
    return pendingList;
  }

  async function remoteSha(name: string): Promise<string> {
    let heads = remote?.heads;
    if (heads === undefined || now() - (remote?.at ?? 0) >= options.ttlMs) {
      await list();
      heads = remote?.heads;
    }
    let sha = heads?.get(name);
    if (sha === undefined && now() - (remote?.at ?? 0) >= MISS_REFRESH_MS) {
      listed = undefined;
      await list();
      sha = remote?.heads.get(name);
    }
    if (sha === undefined) throw new BranchNotFoundError();
    return sha;
  }

  async function snapshot(name: string): Promise<BranchSnapshot> {
    if (!isValidBranchName(name)) throw new BranchNotFoundError();
    const cached = snapshots.get(name);
    if (cached !== undefined && now() - cached.at < options.ttlMs) {
      snapshots.delete(name);
      snapshots.set(name, cached);
      return cached.value;
    }
    const sha = await remoteSha(name);
    if (cached !== undefined && cached.value.sha === sha) {
      snapshots.delete(name);
      snapshots.set(name, { at: now(), value: cached.value });
      return cached.value;
    }
    const config = options.config();
    if (config === null) throw new Error("snapshot not ready");
    const value = await options.withLock(async () => {
      const local = await localHeads();
      if (local.get(name) !== sha) await fetchHeads([name]);
      const built = await buildSnapshot(options.repoDir, config, {
        env: noLazy,
        refs: [{ name, sha, isDefault: true }],
      });
      return { name, sha, snapshot: built };
    });
    snapshots.delete(name);
    snapshots.set(name, { at: now(), value });
    while (snapshots.size > MAX_BRANCH_SNAPSHOTS) {
      const oldest = snapshots.keys().next().value;
      if (oldest === undefined) break;
      snapshots.delete(oldest);
    }
    return value;
  }

  return {
    list,
    snapshot,
    forget(name) {
      snapshots.delete(name);
      listed = undefined;
    },
  };
}
