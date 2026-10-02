import { useCallback, useEffect, useState } from "react";

export function foldedColumnsStorageKey(repoId: string): string {
  return `snoboard:folded-columns:v1:${repoId}`;
}

function readFolded(repoId: string): string[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(foldedColumnsStorageKey(repoId)) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

/** Folded column statuses, persisted per repo. Loaded after mount so SSR markup stays expanded. */
export function useFoldedColumns(repoId: string): {
  folded: ReadonlySet<string>;
  toggle: (status: string) => void;
} {
  const [folded, setFolded] = useState<string[]>([]);

  useEffect(() => {
    setFolded(readFolded(repoId));
  }, [repoId]);

  const toggle = useCallback(
    (status: string) => {
      setFolded((current) => {
        const next = current.includes(status) ? current.filter((entry) => entry !== status) : [...current, status];
        if (typeof localStorage !== "undefined") {
          localStorage.setItem(foldedColumnsStorageKey(repoId), JSON.stringify(next));
        }
        return next;
      });
    },
    [repoId],
  );

  return { folded: new Set(folded), toggle };
}
