import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { isValidBranchName } from "snoboard/browser";
import { setActiveRef } from "@/lib/routes";

/** Last branch picked per repository. `null` (no entry) means the merged view. */
export function refStorageKey(repoId: string): string {
  return `snoboard:ref:v1:${repoId}`;
}

export function defaultBranchStorageKey(repoId: string): string {
  return `snoboard:default-branch:v1:${repoId}`;
}

export const REF_PARAM = "ref";
const FALLBACK_DEFAULT_BRANCH = "main";

/** `?ref=<branch>` from a search string; invalid names are ignored (the URL is shareable, so untrusted). */
export function refFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get(REF_PARAM);
  return value !== null && isValidBranchName(value) ? value : null;
}

export function readStoredRef(repoId: string): string | null {
  if (typeof localStorage === "undefined") return null;
  const value = localStorage.getItem(refStorageKey(repoId));
  return value !== null && isValidBranchName(value) ? value : null;
}

export function rememberRef(repoId: string, ref: string | null): void {
  if (typeof localStorage === "undefined") return;
  if (ref === null) localStorage.removeItem(refStorageKey(repoId));
  else localStorage.setItem(refStorageKey(repoId), ref);
}

/** The URL wins over the remembered branch, so a shared link shows what its author saw. */
export function chooseInitialRef(repoId: string, search: string): string | null {
  return refFromSearch(search) ?? readStoredRef(repoId);
}

function readDefaultBranch(repoId: string): string {
  if (typeof localStorage === "undefined") return FALLBACK_DEFAULT_BRANCH;
  const value = localStorage.getItem(defaultBranchStorageKey(repoId));
  return value !== null && isValidBranchName(value) ? value : FALLBACK_DEFAULT_BRANCH;
}

/** Puts `?ref=` in the address bar (or removes it) without a navigation. */
export function writeRefToUrl(ref: string | null): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (ref === null) url.searchParams.delete(REF_PARAM);
  else url.searchParams.set(REF_PARAM, ref);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

export type BoardRefState = {
  /** Branch the board shows alone, or null for the merged view of all branches. */
  ref: string | null;
  /** The repository's default branch (last known; `main` until the board says otherwise). */
  defaultBranch: string;
  setRef: (next: string | null) => void;
  noteDefaultBranch: (name: string) => void;
};

const BoardRefContext = createContext<BoardRefState>({
  ref: null,
  defaultBranch: FALLBACK_DEFAULT_BRANCH,
  setRef: () => undefined,
  noteDefaultBranch: () => undefined,
});

export function useBoardRef(): BoardRefState {
  return useContext(BoardRefContext);
}

/** The basket follows the branch on screen; the merged view shares the default branch's basket. */
export function useBasketBranch(): { branch: string; isDefault: boolean } {
  const { ref, defaultBranch } = useContext(BoardRefContext);
  const branch = ref ?? defaultBranch;
  return { branch, isDefault: branch === defaultBranch };
}

export function BoardRefProvider({
  repoId,
  initialRef,
  children,
}: {
  repoId: string;
  /** From the request URL (SSR-safe). Undefined: read `?ref=` and the remembered branch in the browser. */
  initialRef?: string | null;
  children: ReactNode;
}) {
  // Only the URL decides the first render (server and browser agree); the remembered branch follows in an effect.
  const [ref, setRefState] = useState<string | null>(() =>
    initialRef !== undefined ? initialRef : typeof window === "undefined" ? null : refFromSearch(window.location.search),
  );
  const [defaultBranch, setDefaultBranch] = useState(() => readDefaultBranch(repoId));
  // API calls read the active ref, so it is published before children render.
  setActiveRef(repoId, ref);

  useEffect(() => {
    // No ?ref= in the URL: fall back to the branch this browser picked last, and make the URL say so.
    if (initialRef !== undefined && initialRef !== null) return;
    if (refFromSearch(window.location.search) !== null) return;
    const stored = readStoredRef(repoId);
    if (stored !== null && stored !== ref) setRefState(stored);
    if (stored !== null) writeRefToUrl(stored);
    // Only on mount and repo change.
  }, [repoId]);

  useEffect(() => () => setActiveRef(repoId, null), [repoId]);

  const setRef = useCallback(
    (next: string | null) => {
      if (next !== null && !isValidBranchName(next)) return;
      rememberRef(repoId, next);
      writeRefToUrl(next);
      setActiveRef(repoId, next);
      setRefState(next);
    },
    [repoId],
  );

  const noteDefaultBranch = useCallback(
    (name: string) => {
      if (!isValidBranchName(name)) return;
      if (typeof localStorage !== "undefined") localStorage.setItem(defaultBranchStorageKey(repoId), name);
      setDefaultBranch(name);
    },
    [repoId],
  );

  const value = useMemo(
    () => ({ ref, defaultBranch, setRef, noteDefaultBranch }),
    [ref, defaultBranch, setRef, noteDefaultBranch],
  );
  return (
    <BoardRefContext.Provider value={value}>
      {/* A new branch remounts the page so every request and the basket follow it. */}
      <Fragment key={ref ?? ""}>{children}</Fragment>
    </BoardRefContext.Provider>
  );
}
