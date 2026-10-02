import { createContext, useContext, useEffect, type ReactNode } from "react";
import { usePageContext } from "vike-react/usePageContext";
import { DEFAULT_REPO_ID } from "@/features/basket/store";
import { isRepoId, rememberRepo, repoIdFromPath } from "@/lib/routes";

const RepoContext = createContext(DEFAULT_REPO_ID);

export function RepoProvider({ repoId, children }: { repoId: string; children: ReactNode }) {
  useEffect(() => {
    rememberRepo(repoId);
  }, [repoId]);
  return <RepoContext.Provider value={repoId}>{children}</RepoContext.Provider>;
}

export function useRepoId(): string {
  return useContext(RepoContext);
}

export function RepoScope({ children }: { children: ReactNode }) {
  const pageContext = usePageContext();
  // A same-page history update (details `?open=`) can re-render without route params; the path still names the repo.
  const repo =
    pageContext.routeParams?.repo ??
    repoIdFromPath(pageContext.urlPathname ?? "") ??
    (typeof window === "undefined" ? null : repoIdFromPath(window.location.pathname));
  if (typeof repo !== "string" || !isRepoId(repo)) {
    return <p className="p-4 text-sm text-muted-foreground">Unknown repository.</p>;
  }
  return <RepoProvider repoId={repo}>{children}</RepoProvider>;
}
