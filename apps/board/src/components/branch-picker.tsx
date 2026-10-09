import { Check, ChevronDown, GitBranch } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { isValidBranchName } from "snoboard/browser";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useBasket } from "@/features/basket/store";
import { formatAge } from "@/features/board/age";
import { redirectToLogin } from "@/features/board/sync";
import { useBoardRef } from "@/features/repo/branch-context";
import { useRepoId } from "@/features/repo/context";
import { repoApi } from "@/lib/routes";

export const MERGED_LABEL = "All branches (merged)";

export type BranchEntry = { name: string; sha: string; date: string };

export type BranchChoice = { value: string | null; label: string; branch?: BranchEntry };

export function parseBranchList(value: unknown): { defaultBranch?: string; branches: BranchEntry[] } {
  if (typeof value !== "object" || value === null || !Array.isArray((value as { branches?: unknown }).branches)) {
    return { branches: [] };
  }
  const record = value as { defaultBranch?: unknown; branches: unknown[] };
  const branches: BranchEntry[] = [];
  for (const entry of record.branches) {
    if (typeof entry !== "object" || entry === null) continue;
    const { name, sha, date } = entry as Record<string, unknown>;
    if (!isValidBranchName(name) || typeof sha !== "string" || typeof date !== "string") continue;
    branches.push({ name, sha: sha.slice(0, 12), date });
  }
  return {
    ...(isValidBranchName(record.defaultBranch) ? { defaultBranch: record.defaultBranch } : {}),
    branches,
  };
}

/**
 * Picker rows: the merged view, the default branch, then every other branch in server order
 * (newest commit first). Typing filters by substring, case-insensitive; the merged row stays
 * only while it matches too.
 */
export function branchChoices(
  branches: readonly BranchEntry[],
  defaultBranch: string,
  query: string,
): BranchChoice[] {
  const needle = query.trim().toLowerCase();
  const matches = (text: string) => needle.length === 0 || text.toLowerCase().includes(needle);
  const rows: BranchChoice[] = [];
  if (matches(MERGED_LABEL)) rows.push({ value: null, label: MERGED_LABEL });
  const main = branches.find((branch) => branch.name === defaultBranch);
  if (matches(defaultBranch)) rows.push({ value: defaultBranch, label: defaultBranch, ...(main === undefined ? {} : { branch: main }) });
  for (const branch of branches) {
    if (branch.name === defaultBranch || !matches(branch.name)) continue;
    rows.push({ value: branch.name, label: branch.name, branch });
  }
  return rows;
}

/** Wraps each case-insensitive occurrence of `query` in <mark>. */
export function highlight(text: string, query: string): ReactNode {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return text;
  const parts: ReactNode[] = [];
  const lower = text.toLowerCase();
  let at = 0;
  let found = lower.indexOf(needle);
  while (found !== -1) {
    if (found > at) parts.push(text.slice(at, found));
    parts.push(
      <mark key={found} className="rounded-sm bg-yellow-200 px-0 text-inherit dark:bg-yellow-700/60">
        {text.slice(found, found + needle.length)}
      </mark>,
    );
    at = found + needle.length;
    found = lower.indexOf(needle, at);
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

function formatDate(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  return new Date(time).toISOString().slice(0, 10);
}

/**
 * Header chip with the branch the board shows, and a searchable combobox to change it.
 * Switching with pending edits asks first; the edits stay saved for the branch they were made on.
 */
export function BranchPicker({ now }: { now?: number } = {}) {
  const repoId = useRepoId();
  const { ref, defaultBranch, setRef, noteDefaultBranch } = useBoardRef();
  const basket = useBasket(repoId);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [branches, setBranches] = useState<BranchEntry[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState<{ value: string | null } | null>(null);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const basketBranch = ref ?? defaultBranch;

  useEffect(() => {
    if (!open || branches !== null) return;
    const controller = new AbortController();
    void fetch(repoApi(repoId, "/branches"), { credentials: "same-origin", signal: controller.signal })
      .then(async (response) => {
        if (controller.signal.aborted) return;
        if (response.status === 401) {
          redirectToLogin();
          return;
        }
        const body: unknown = await response.json().catch(() => null);
        if (controller.signal.aborted) return;
        if (!response.ok) {
          setProblem("Could not list branches.");
          setBranches([]);
          return;
        }
        const parsed = parseBranchList(body);
        if (parsed.defaultBranch !== undefined && parsed.defaultBranch !== defaultBranch) {
          noteDefaultBranch(parsed.defaultBranch);
        }
        setBranches(parsed.branches);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setProblem("Could not list branches.");
        setBranches([]);
      });
    return () => controller.abort();
  }, [open, branches, repoId, defaultBranch, noteDefaultBranch]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  const choices = useMemo(() => branchChoices(branches ?? [], defaultBranch, query), [branches, defaultBranch, query]);
  const activeIndex = Math.min(active, Math.max(0, choices.length - 1));
  const optionId = (index: number) => `${listId}-option-${index}`;

  useEffect(() => {
    if (!open) return;
    document.getElementById(optionId(activeIndex))?.scrollIntoView?.({ block: "nearest" });
    // optionId is stable for a given listId.
  }, [open, activeIndex, listId]);

  function close(): void {
    setOpen(false);
    setQuery("");
    setActive(0);
    triggerRef.current?.focus();
  }

  function choose(value: string | null): void {
    setOpen(false);
    setQuery("");
    setActive(0);
    if (value === ref) return;
    if (basket.edits.length > 0) {
      setPending({ value });
      return;
    }
    setRef(value);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActive(choices.length === 0 ? 0 : (activeIndex + 1) % choices.length);
        return;
      case "ArrowUp":
        event.preventDefault();
        setActive(choices.length === 0 ? 0 : (activeIndex - 1 + choices.length) % choices.length);
        return;
      case "Home":
        event.preventDefault();
        setActive(0);
        return;
      case "End":
        event.preventDefault();
        setActive(Math.max(0, choices.length - 1));
        return;
      case "Enter": {
        event.preventDefault();
        const choice = choices[activeIndex];
        if (choice !== undefined) choose(choice.value);
        return;
      }
      case "Escape":
        event.preventDefault();
        close();
        return;
      default:
    }
  }

  const label = ref ?? MERGED_LABEL;
  const count = basket.edits.length;
  const nowMs = now ?? Date.now();

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        data-testid="branch-chip"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Branch: ${label}`}
        title={ref === null ? "Showing every branch merged. Pick one branch to see it alone." : `Showing ${ref} alone`}
        onClick={() => (open ? close() : setOpen(true))}
        className={`inline-flex h-8 max-w-56 items-center gap-1 rounded-full border px-2 text-sm sm:gap-1.5 sm:px-3 ${
          ref === null ? "bg-background" : "border-primary/50 bg-primary/10 font-medium"
        }`}
      >
        <GitBranch aria-hidden="true" className="size-4 shrink-0" />
        {/* Phones: a short chip so the header actions still fit. */}
        <span className="max-w-[4.5rem] truncate sm:max-w-48">
          {ref === null ? (
            <>
              <span className="sm:hidden">All</span>
              <span className="hidden sm:inline">{MERGED_LABEL}</span>
            </>
          ) : (
            ref
          )}
        </span>
        <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 opacity-60" />
      </button>
      {open ? (
        <div className="absolute right-0 z-50 mt-1 w-[min(20rem,calc(100vw-2rem))] rounded-lg border bg-popover p-1 text-popover-foreground shadow-md">
          <input
            ref={inputRef}
            role="combobox"
            aria-label="Find a branch"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={choices.length === 0 ? undefined : optionId(activeIndex)}
            placeholder="Find a branch…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            className="h-8 w-full rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <ul id={listId} role="listbox" aria-label="Branches" className="mt-1 max-h-80 overflow-y-auto">
            {choices.map((choice, index) => {
              const selected = choice.value === ref;
              const age = choice.branch === undefined ? null : formatAge(choice.branch.date, nowMs);
              return (
                <li
                  key={choice.value ?? ""}
                  id={optionId(index)}
                  role="option"
                  aria-selected={selected}
                  data-active={index === activeIndex ? "true" : undefined}
                  data-testid="branch-option"
                  onPointerMove={() => setActive(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(choice.value)}
                  className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
                    index === activeIndex ? "bg-accent text-accent-foreground" : ""
                  }`}
                >
                  <Check aria-hidden="true" className={`size-4 shrink-0 ${selected ? "" : "invisible"}`} />
                  <span className="min-w-0 flex-1 truncate">{highlight(choice.label, query)}</span>
                  {choice.branch !== undefined ? (
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      <span className="font-mono">{choice.branch.sha.slice(0, 7)}</span>{" "}
                      <time dateTime={choice.branch.date} title={choice.branch.date}>
                        {formatDate(choice.branch.date)}
                      </time>
                      {age === null ? null : ` · ${age === "now" ? "now" : `${age} ago`}`}
                    </span>
                  ) : null}
                </li>
              );
            })}
            {branches === null ? (
              <li role="presentation" className="px-2 py-1.5 text-sm text-muted-foreground">
                Loading branches…
              </li>
            ) : choices.length === 0 ? (
              <li role="presentation" className="px-2 py-1.5 text-sm text-muted-foreground">
                No branch matches.
              </li>
            ) : null}
            {problem !== null ? (
              <li role="presentation" className="px-2 py-1.5 text-sm text-destructive">
                {problem}
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
      <Dialog open={pending !== null} onOpenChange={(next) => (next ? undefined : setPending(null))}>
        <DialogContent data-testid="branch-switch-dialog">
          <DialogHeader>
            <DialogTitle>Switch branch?</DialogTitle>
            <DialogDescription>
              You have {count} pending {count === 1 ? "edit" : "edits"} on {basketBranch}. Switch anyway? They stay saved
              for {basketBranch}.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                const next = pending;
                setPending(null);
                if (next !== null) setRef(next.value);
              }}
            >
              Switch
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
