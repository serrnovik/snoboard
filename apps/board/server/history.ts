import {
  botPatterns,
  commitsUnder,
  folderHistory,
  peopleByFolder,
  type Config,
  type FolderHistory,
  type InitiativePeople,
  type Snapshot,
} from "snoboard";

/** Commits per history page, and the most the client may ask for. */
export const HISTORY_PAGE = 20;
const MAX_HISTORY_CACHE = 200;

type PeopleEntry = { key: string; value: Promise<Record<string, InitiativePeople>> };

const historyCache = new Map<string, Promise<FolderHistory>>();
const peopleCache = new Map<string, PeopleEntry>();

export function resetHistoryCaches(): void {
  historyCache.clear();
  peopleCache.clear();
}

function defaultSha(snapshot: Snapshot): string | undefined {
  return snapshot.refs.find((ref) => ref.isDefault)?.sha;
}

export function folderOf(itemPath: string): string {
  return itemPath.slice(0, itemPath.lastIndexOf("/"));
}

/**
 * Default-branch commits touching one initiative folder. Cached per snapshot (keyed by
 * the default branch tip), so repeated opens never re-run git until the next sync.
 */
export function initiativeHistory(
  repoId: string,
  repoDir: string,
  snapshot: Snapshot,
  itemPath: string,
  skip: number,
): Promise<FolderHistory> {
  const sha = defaultSha(snapshot);
  if (sha === undefined) return Promise.resolve({ commits: [], hasMore: false });
  const key = `${repoId}\n${sha}\n${itemPath}\n${skip}`;
  const cached = historyCache.get(key);
  if (cached !== undefined) return cached;
  const pending = folderHistory(repoDir, sha, folderOf(itemPath), { limit: HISTORY_PAGE, skip });
  pending.catch(() => historyCache.delete(key));
  if (historyCache.size >= MAX_HISTORY_CACHE) historyCache.delete(historyCache.keys().next().value!);
  historyCache.set(key, pending);
  return pending;
}

/**
 * Creator and participants for every initiative, keyed by initiative id. One bounded
 * `git log` over the root per snapshot; later calls reuse the result.
 */
export function snapshotPeople(
  repoId: string,
  repoDir: string | undefined,
  snapshot: Snapshot,
  config: Config,
  extraBots: string | undefined = process.env.SNOBOARD_BOT_AUTHORS,
): Promise<Record<string, InitiativePeople>> {
  const sha = defaultSha(snapshot);
  if (repoDir === undefined || sha === undefined) return Promise.resolve({});
  const key = `${sha}\n${config.root}\n${config.file}\n${extraBots ?? ""}`;
  const cached = peopleCache.get(repoId);
  if (cached !== undefined && cached.key === key) return cached.value;
  const value = commitsUnder(repoDir, sha, config.root)
    .then((commits) => {
      const byFolder = peopleByFolder(commits, config.file, botPatterns(extraBots));
      const result: Record<string, InitiativePeople> = {};
      for (const item of snapshot.items) {
        const people = byFolder.get(folderOf(item.path));
        if (people !== undefined) result[item.id] = people;
      }
      return result;
    })
    .catch(() => {
      if (peopleCache.get(repoId)?.key === key) peopleCache.delete(repoId);
      return {};
    });
  peopleCache.set(repoId, { key, value });
  return value;
}
