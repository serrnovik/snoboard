import { useEffect, useState } from "react";
import { usePageContext } from "vike-react/usePageContext";
import { browserLocation } from "@/features/board/sync";
import {
  loadRepoChoices,
  pathForRepoSwitch,
  rememberRepo,
  repoIdFromPath,
  type RepoChoice,
} from "@/lib/routes";

export function RepoSwitcher({
  repos,
  repoId,
  pathname,
  readSearch = currentSearch,
  onNavigate,
}: {
  repos: readonly RepoChoice[];
  repoId: string;
  pathname: string;
  /** Read at change time: the board updates filters with pushState without rerendering this header. */
  readSearch?: () => string;
  onNavigate?: (href: string) => void;
}) {
  if (repos.length <= 1) return null;
  const current = repos.some((repo) => repo.id === repoId) ? repoId : repos[0]?.id ?? repoId;
  return (
    <select
      aria-label="Repository"
      className="h-8 max-w-48 rounded-md border bg-background px-2 text-sm"
      value={current}
      onChange={(event) => {
        const next = event.target.value;
        rememberRepo(next);
        const href = pathForRepoSwitch(pathname, readSearch(), next);
        if (onNavigate !== undefined) onNavigate(href);
        else browserLocation.assign(href);
      }}
    >
      {repos.map((repo) => (
        <option key={repo.id} value={repo.id}>
          {repo.name}
        </option>
      ))}
    </select>
  );
}

export function RepoSwitcherBar() {
  const pageContext = usePageContext();
  const pathname = pageContext.urlPathname;
  const [repos, setRepos] = useState<RepoChoice[] | null>(null);

  useEffect(() => {
    if (pathname === "/login" || pathname === "/login/") return;
    const controller = new AbortController();
    void loadRepoChoices(controller.signal)
      .then((choices) => {
        if (!controller.signal.aborted) setRepos(choices);
      })
      .catch(() => {
        if (!controller.signal.aborted) setRepos([]);
      });
    return () => controller.abort();
  }, [pathname]);

  const hidden = pathname === "/login" || pathname === "/login/" || repos === null || repos.length <= 1;
  if (hidden) return null;
  const routeRepo = repoIdFromPath(pathname);
  const routeRepoIsListed = routeRepo !== null && repos.some((repo) => repo.id === routeRepo);
  const repoId = routeRepoIsListed ? routeRepo : (repos[0]?.id ?? "");
  return <RepoSwitcher repos={repos} repoId={repoId} pathname={pathname} />;
}

function currentSearch(): string {
  return typeof window === "undefined" ? "" : window.location.search;
}
