import { useEffect, useState } from "react";
import { browserLocation } from "@/features/board/sync";
import { chooseRepoId, legacyRedirectPath, loadRepoChoices, readLastRepo } from "@/lib/routes";

/**
 * Old `/`, `/graph` and `/initiatives/<id>` URLs. Waits for the repository list:
 * guessing an id (such as `default`) would 404 on a multi-repo board.
 */
export function LegacyRedirect() {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const pathname = window.location.pathname;
    const search = window.location.search;
    setFailed(false);
    void loadRepoChoices(controller.signal)
      .then((repos) => {
        if (controller.signal.aborted) return;
        const firstRepo = repos[0]?.id;
        if (firstRepo === undefined) {
          setFailed(true);
          return;
        }
        // The legacy initiative API serves the first repository; keep old bookmarks there.
        const target = legacyRedirectPath(pathname, search, chooseRepoId(repos, readLastRepo()), firstRepo);
        const alreadyThere = target === null || target === `${pathname}${search}`;
        if (alreadyThere) return;
        browserLocation.replace(target);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [attempt]);

  if (failed) {
    return (
      <div className="flex flex-col items-start gap-2 p-6 text-sm">
        <p role="alert" className="text-destructive">
          Could not load the list of repositories.
        </p>
        <button
          type="button"
          className="rounded-md border px-2.5 py-1 hover:bg-muted"
          onClick={() => setAttempt((value) => value + 1)}
        >
          Retry
        </button>
      </div>
    );
  }
  return <p className="p-6 text-sm text-muted-foreground">Opening the board…</p>;
}
