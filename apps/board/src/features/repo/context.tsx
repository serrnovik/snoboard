import { createContext, useContext, useEffect, type ReactNode } from "react";
import { usePageContext } from "vike-react/usePageContext";
import { BranchPicker } from "@/components/branch-picker";
import { PageActionsPortal } from "@/components/page-actions";
import { DEFAULT_REPO_ID } from "@/features/basket/store";
import { BoardRefProvider, refFromSearch } from "@/features/repo/branch-context";
import { isRepoId, rememberRepo, repoIdFromPath } from "@/lib/routes";

const RepoContext = createContext(DEFAULT_REPO_ID);

export function RepoProvider({
  repoId,
  initialRef,
  children,
}: {
  repoId: string;
  initialRef?: string | null;
  children: ReactNode;
}) {
  useEffect(() => {
    rememberRepo(repoId);
  }, [repoId]);
  return (
    <RepoContext.Provider value={repoId}>
      <BoardRefProvider repoId={repoId} {...(initialRef === undefined ? {} : { initialRef })}>
        <PageActionsPortal>
          <BranchPicker />
        </PageActionsPortal>
        {children}
      </BoardRefProvider>
    </RepoContext.Provider>
  );
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
  // `?ref=` from the request, so the server render and the browser agree on the branch.
  const search = pageContext.urlParsed?.searchOriginal ?? (typeof window === "undefined" ? "" : window.location.search);
  const fromUrl = refFromSearch(search ?? "");
  return (
    <RepoProvider repoId={repo} {...(fromUrl === null ? {} : { initialRef: fromUrl })}>
      {children}
    </RepoProvider>
  );
}
