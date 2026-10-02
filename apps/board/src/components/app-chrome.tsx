import { useState, type ReactNode } from "react";
import { usePageContext } from "vike-react/usePageContext";
import { BoardNav } from "@/components/nav";
import { PageActionsProvider } from "@/components/page-actions";
import { RepoSwitcherBar } from "@/components/repo-switcher";
import { SessionActions } from "@/components/session-actions";
import { ThemeToggle } from "@/components/theme-toggle";
import { boardPath, repoIdFromPath } from "@/lib/routes";

export function AppChrome({ children }: { children: ReactNode }) {
  const [pageActions, setPageActions] = useState<HTMLElement | null>(null);
  const pathname = usePageContext().urlPathname;
  const repoId = repoIdFromPath(pathname);
  const home = repoId === null ? "/" : boardPath(repoId);

  return (
    <PageActionsProvider element={pageActions}>
      <div className="flex min-h-svh flex-col bg-background text-foreground">
        <header className="flex shrink-0 flex-col border-b px-4 sm:h-12 sm:flex-row sm:items-center sm:gap-4">
          <div className="flex min-h-12 min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-1 sm:min-h-0 sm:flex-nowrap sm:gap-4 sm:py-0">
            <a href={home} className="flex shrink-0 items-center gap-2 font-semibold tracking-tight">
              <span className="inline-flex shrink-0 rounded-md bg-white p-0.5 ring-1 ring-foreground/15">
                <img src="/logo.png" alt="" width={24} height={24} className="size-6 rounded-sm" />
              </span>
              Snoboard
            </a>
            <BoardNav />
            <RepoSwitcherBar />
          </div>
          <div className="hidden flex-1 sm:block" />
          <div className="flex min-h-12 shrink-0 items-center gap-2 sm:min-h-0">
            <div ref={setPageActions} className="flex items-center gap-2 empty:hidden" />
            <ThemeToggle />
            <SessionActions />
          </div>
        </header>
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </PageActionsProvider>
  );
}
