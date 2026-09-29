import { useState, type ReactNode } from "react";
import { BoardNav } from "@/components/nav";
import { PageActionsProvider } from "@/components/page-actions";
import { SessionActions } from "@/components/session-actions";
import { ThemeToggle } from "@/components/theme-toggle";

export function AppChrome({ children }: { children: ReactNode }) {
  const [pageActions, setPageActions] = useState<HTMLElement | null>(null);

  return (
    <PageActionsProvider element={pageActions}>
      <div className="flex min-h-svh flex-col bg-background text-foreground">
        <header className="flex shrink-0 flex-col border-b px-4 sm:h-12 sm:flex-row sm:items-center sm:gap-4">
          <div className="flex min-h-12 min-w-0 items-center gap-3 sm:min-h-0 sm:gap-4">
            <a href="/" className="shrink-0 font-semibold tracking-tight">
              Snoboard
            </a>
            <BoardNav />
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
