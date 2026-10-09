import { parseQualifiedId } from "./ids.js";

export const DEFAULT_REPO_ID = "default";
export const LAST_REPO_STORAGE_KEY = "snoboard:last-repo:v1";

const REPO_ID = /^[a-z0-9-]{1,32}$/;

export function isRepoId(value: string): boolean {
  return REPO_ID.test(value);
}

export function boardPath(repoId: string): string {
  return `/r/${repoId}/`;
}

export function graphPath(repoId: string): string {
  return `/r/${repoId}/graph`;
}

const activeRefs = new Map<string, string>();

/** The branch the board shows for `repoId` (null: merged view). Read API calls follow it. */
export function setActiveRef(repoId: string, ref: string | null): void {
  if (ref === null) activeRefs.delete(repoId);
  else activeRefs.set(repoId, ref);
}

export function activeRef(repoId: string): string | null {
  return activeRefs.get(repoId) ?? null;
}

/** Routes that never take `?ref=`: the list itself, refresh, and submit (which names its branch in the body). */
const REF_FREE = /^\/(branches|refresh|edits\/submit|issues\/)/;

export function repoApi(repoId: string, path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  const base = `/api/repos/${encodeURIComponent(repoId)}${suffix}`;
  const ref = activeRefs.get(repoId);
  if (ref === undefined || REF_FREE.test(suffix)) return base;
  return `${base}${base.includes("?") ? "&" : "?"}ref=${encodeURIComponent(ref)}`;
}

export function repoIdFromPath(pathname: string): string | null {
  const match = /^\/r\/([^/]+)(?:\/|$)/.exec(pathname);
  if (match?.[1] === undefined) return null;
  try {
    const id = decodeURIComponent(match[1]);
    return isRepoId(id) ? id : null;
  } catch {
    return null;
  }
}

export function chooseRepoId(repos: readonly { id: string }[], lastUsed: string | null): string {
  if (lastUsed !== null && repos.some((repo) => repo.id === lastUsed)) return lastUsed;
  if (repos.length === 0 && lastUsed !== null) return lastUsed;
  return repos[0]?.id ?? DEFAULT_REPO_ID;
}

export function readLastRepo(): string | null {
  if (typeof window === "undefined") return null;
  const value = window.localStorage.getItem(LAST_REPO_STORAGE_KEY);
  if (value === null || !isRepoId(value)) return null;
  return value;
}

export function rememberRepo(repoId: string): void {
  if (typeof window === "undefined" || !isRepoId(repoId)) return;
  window.localStorage.setItem(LAST_REPO_STORAGE_KEY, repoId);
}

function withSearch(path: string, search: string): string {
  if (search.length === 0 || search === "?") return path;
  return `${path}${search.startsWith("?") ? search : `?${search}`}`;
}

/**
 * Old bookmarks land on the same page inside the chosen repository. An unqualified
 * `/initiatives/<id>` goes to `legacyRepoId`, the repo the legacy `/api/initiatives/<id>`
 * serves (the first one), so the bookmark keeps pointing at the same initiative.
 */
export function legacyRedirectPath(
  pathname: string,
  search: string,
  repoId: string,
  legacyRepoId: string = repoId,
): string | null {
  if (pathname === "/" || pathname === "") return withSearch(boardPath(repoId), search);
  if (pathname === "/graph" || pathname === "/graph/") return withSearch(graphPath(repoId), search);
  const initiative = /^\/initiatives\/([^/]+)\/?$/.exec(pathname);
  if (initiative?.[1] === undefined) return null;
  let raw = initiative[1];
  try {
    raw = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const qualified = parseQualifiedId(raw);
  if (qualified !== null) return withSearch(`/r/${qualified.repo}/initiatives/${encodeURIComponent(qualified.id)}`, search);
  return withSearch(`/r/${legacyRepoId}/initiatives/${encodeURIComponent(raw)}`, search);
}

/** `?open=<id>` names an initiative in the current repo, so a switch drops it and keeps the rest. */
function searchForOtherRepo(search: string): string {
  const params = new URLSearchParams(search);
  params.delete("open");
  // A branch belongs to one repository; the next one opens on its own remembered branch.
  params.delete("ref");
  const rest = params.toString();
  return rest.length === 0 ? "" : `?${rest}`;
}

export function pathForRepoSwitch(pathname: string, currentSearch: string, nextRepo: string): string {
  const search = searchForOtherRepo(currentSearch);
  if (pathname === "/graph" || pathname === "/graph/" || /^\/r\/[^/]+\/graph\/?$/.test(pathname)) {
    return withSearch(graphPath(nextRepo), search);
  }
  if (/^\/initiatives\/[^/]+\/?$/.test(pathname) || /^\/r\/[^/]+\/initiatives\/[^/]+\/?$/.test(pathname)) {
    return boardPath(nextRepo);
  }
  return withSearch(boardPath(nextRepo), search);
}

export type RepoChoice = {
  id: string;
  name: string;
};

export async function loadRepoChoices(signal?: AbortSignal): Promise<RepoChoice[]> {
  const response = await fetch("/api/repos", { credentials: "same-origin", signal });
  if (!response.ok) throw new Error(`could not load repositories (${response.status})`);
  const body: unknown = await response.json().catch(() => null);
  if (!Array.isArray(body)) throw new Error("could not load repositories");
  const choices: RepoChoice[] = [];
  for (const entry of body) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || !isRepoId(record.id)) continue;
    if (typeof record.name !== "string" || record.name.length === 0) continue;
    choices.push({ id: record.id, name: record.name });
  }
  return choices;
}
