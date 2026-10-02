import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import type { BoardItem } from "snoboard/browser";
import { redirectToLogin } from "@/features/board/sync";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { EditControls } from "@/features/details/EditControls";
import { IssueBadge, normalizeIssues } from "@/features/issues/IssueBadge";
import { forgeFileUrl, forgeFolderUrl, forgePrUrl, type ForgeLinkConfig } from "./links.js";
import { SummaryMarkdown } from "./markdown.js";
import { readLinks } from "./ListEditors";
import { resolveImageSrc } from "@/features/attachments/images";
import { isSafeLinkUrl } from "snoboard/browser";
import { currentOpenId, initiativeIdOf, setOpenId } from "./open.js";
import { useRepoId } from "@/features/repo/context";
import { formatQualifiedId, initiativeDetailsPath, parseQualifiedId, shareUrl } from "@/lib/ids";
import { boardPath, repoApi } from "@/lib/routes";

export type PullEnrichment = {
  state: string;
  merged: boolean;
  checks: string | null;
};

export type InitiativeDetails = BoardItem & {
  blockedChain: string[];
  dependents: string[];
  forge?: ForgeLinkConfig;
  prs?: Record<string, PullEnrichment>;
};

const DEFAULT_FORGE: ForgeLinkConfig = {
  type: "github",
  repo: "owner/name",
  fileUrl: "https://github.com/{repo}/blob/{ref}/{path}",
  prUrl: "https://github.com/{repo}/pull/{pr}",
};

type LoadState = {
  phase: "loading" | "error" | "ready";
  data: InitiativeDetails | null;
  message: string | null;
};

export function DetailsDrawer() {
  const [openId, setCurrent] = useState<string | null>(null);

  useEffect(() => {
    const sync = () => setCurrent(currentOpenId());
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  return (
    <DetailsSheet
      openId={openId}
      onOpenChange={(open) => {
        if (!open) setOpenId(null);
      }}
    />
  );
}

export function DetailsSheet({
  openId,
  onOpenChange,
}: {
  openId: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={openId !== null} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full overflow-y-auto data-[side=right]:sm:max-w-xl!"
        data-testid="details-sheet"
      >
        {openId !== null ? <InitiativeBody id={openId} variant="sheet" /> : null}
      </SheetContent>
    </Sheet>
  );
}

export function InitiativePage({ id }: { id: string }) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
      <InitiativeBody id={id} variant="page" />
    </main>
  );
}

function InitiativeBody({ id, variant }: { id: string; variant: "sheet" | "page" }) {
  const repoId = useRepoId();
  const state = useInitiative(id);
  const title = state.data?.title ?? id;
  const qualified = formatQualifiedId(repoId, id);
  return (
    <div className="flex flex-col gap-4" data-testid="initiative-details">
      {variant === "sheet" ? (
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{qualified}</SheetDescription>
        </SheetHeader>
      ) : (
        <header className="flex flex-col gap-1">
          <p className="font-mono text-xs text-muted-foreground">{qualified}</p>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        </header>
      )}
      {state.phase === "loading" ? <p className="px-4 text-sm text-muted-foreground">Loading initiative…</p> : null}
      {state.phase === "error" ? (
        <p role="alert" className="mx-4 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
          {state.message ?? "Could not load the initiative"}
        </p>
      ) : null}
      {state.phase === "ready" && state.data !== null ? (
        <InitiativeContent item={state.data} variant={variant} />
      ) : null}
    </div>
  );
}

function InitiativeContent({ item, variant }: { item: InitiativeDetails; variant: "sheet" | "page" }) {
  const repoId = useRepoId();
  const forge = isForge(item.forge) ? item.forge : DEFAULT_FORGE;
  const fileHref = forgeFileUrl(forge, item.sourceRef, item.path);
  const folderHref = forgeFolderUrl(forge, item.sourceRef, item.path);
  const dependencies = item.depends_on ?? [];
  const issues = normalizeIssues(item.issues);
  return (
    <div className={variant === "sheet" ? "flex flex-col gap-4 px-4 pb-4" : "flex flex-col gap-4"}>
      <EditControls item={item} />
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Summary</h2>
        <SummaryMarkdown
          markdown={item.summary}
          resolveImage={(src) => resolveImageSrc(src, { repoId, id: item.id })}
        />
      </section>
      <ExternalLinks links={item.links} />
      {issues.length > 0 ? (
        <section className="flex flex-col gap-2" data-testid="issue-list">
          <h2 className="text-sm font-medium">Issues</h2>
          <ul className="flex flex-col gap-2">
            {issues.map((issue, index) => (
              <li key={`${issue.raw}:${index}`}>
                <IssueBadge issue={issue} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Phases</h2>
        {item.phases === undefined || item.phases.length === 0 ? (
          <p className="text-sm text-muted-foreground">No phases.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="py-1 pr-3 font-medium">Phase</th>
                  <th className="py-1 pr-3 font-medium">Status</th>
                  <th className="py-1 font-medium">Pull request</th>
                </tr>
              </thead>
              <tbody>
                {item.phases.map((phase) => {
                  const enrichment = phase.pr === undefined ? undefined : item.prs?.[String(phase.pr)];
                  return (
                    <tr key={phase.id} className="border-b border-border/60">
                      <td className="py-2 pr-3">
                        <span className="text-muted-foreground">{phase.id}. </span>
                        {phase.title}
                      </td>
                      <td className="py-2 pr-3">{phase.status}</td>
                      <td className="py-2">
                        {phase.pr === undefined ? (
                          "—"
                        ) : (
                          <span className="inline-flex flex-wrap items-center gap-2">
                            <a
                              href={forgePrUrl(forge, phase.pr)}
                              rel="noopener noreferrer"
                              target="_blank"
                            >
                              #{phase.pr}
                            </a>
                            {enrichment !== undefined ? <PullStatus enrichment={enrichment} /> : null}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="flex flex-col gap-2 text-sm">
        <h2 className="font-medium">Dependencies</h2>
        <p>
          <span className="text-muted-foreground">Depends on </span>
          <IdList ids={dependencies} variant={variant} />
        </p>
        <p>
          <span className="text-muted-foreground">Dependents </span>
          <IdList ids={item.dependents} variant={variant} />
        </p>
      </section>
      <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Source</dt>
        <dd className="min-w-0 break-all">{item.sourceRef}</dd>
        <dt className="text-muted-foreground">On branches</dt>
        <dd className="min-w-0">
          {item.onBranches.length === 0 ? (
            "—"
          ) : (
            <ul className="max-h-40 overflow-y-auto font-mono text-xs leading-5">
              {item.onBranches.map((branch) => (
                <li key={branch} className="truncate" title={branch}>
                  {branch}
                </li>
              ))}
            </ul>
          )}
        </dd>
        <dt className="text-muted-foreground">Last updated</dt>
        <dd>
          <time dateTime={item.updatedAt}>{item.updated}</time>
        </dd>
      </dl>
      <p className="flex flex-wrap gap-3 text-sm">
        <ForgeLink href={fileHref}>initiative.md</ForgeLink>
        <ForgeLink href={folderHref}>Folder</ForgeLink>
        {variant === "sheet" ? (
          <DetailsLink href={initiativeDetailsPath(repoId, item.id)}>Open full page</DetailsLink>
        ) : (
          <DetailsLink href={boardPath(repoId)}>Back to board</DetailsLink>
        )}
        <CopyLink repoId={repoId} id={item.id} />
      </p>
    </div>
  );
}

const detailsLinkClass = "text-primary underline-offset-4 hover:underline";

/** `links` from frontmatter. Only https: and mailto: URLs become links; anything else is not shown. */
function ExternalLinks({ links }: { links: unknown }) {
  const safe = readLinks(links).filter((link) => link.title.trim().length > 0 && isSafeLinkUrl(link.url));
  if (safe.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" data-testid="external-links">
      <h2 className="text-sm font-medium">Links</h2>
      <ul className="flex flex-col gap-1 text-sm">
        {safe.map((link, index) => (
          <li key={`${link.url}:${index}`} className="min-w-0">
            <a
              className={`inline-flex max-w-full items-center gap-1 ${detailsLinkClass}`}
              href={link.url}
              rel="noopener noreferrer"
              target="_blank"
            >
              <span className="truncate">{link.title}</span>
              <ExternalLink aria-hidden="true" className="size-3.5 shrink-0" />
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ForgeLink({ href, children }: { href: string; children: string }) {
  return (
    <a className={`inline-flex items-center gap-1 ${detailsLinkClass}`} href={href} rel="noopener noreferrer" target="_blank">
      {children}
      <ExternalLink aria-hidden="true" className="size-3.5" />
    </a>
  );
}

function DetailsLink({ href, children }: { href: string; children: string }) {
  return (
    <a className={detailsLinkClass} href={href}>
      {children}
    </a>
  );
}

function PullStatus({ enrichment }: { enrichment: PullEnrichment }) {
  const label = enrichment.merged ? "merged" : enrichment.state;
  const checks = enrichment.checks === null ? null : `checks ${enrichment.checks}`;
  return (
    <span className="text-xs text-muted-foreground">
      {label}
      {checks !== null ? ` · ${checks}` : ""}
    </span>
  );
}

function CopyLink({ repoId, id }: { repoId: string; id: string }) {
  return (
    <button
      type="button"
      className={detailsLinkClass}
      onClick={() => {
        void navigator.clipboard?.writeText(shareUrl(window.location.origin, repoId, id));
      }}
    >
      Copy link
    </button>
  );
}

function IdList({ ids, variant }: { ids: readonly string[]; variant: "sheet" | "page" }) {
  if (ids.length === 0) return <span>none</span>;
  return (
    <span className="inline-flex flex-wrap gap-x-2">
      {ids.map((id) => (
        <DependencyLink key={id} id={id} variant={variant} />
      ))}
    </span>
  );
}

function DependencyLink({ id, variant }: { id: string; variant: "sheet" | "page" }) {
  const repoId = useRepoId();
  const hash = id.indexOf("#");
  const base = hash === -1 ? id : id.slice(0, hash);
  const phase = hash === -1 ? "" : id.slice(hash);
  const qualified = parseQualifiedId(base);
  const targetRepo = qualified?.repo ?? repoId;
  const targetId = qualified?.id ?? initiativeIdOf(base);
  const text = `${formatQualifiedId(targetRepo, targetId)}${phase}`;
  const href = initiativeDetailsPath(targetRepo, targetId);
  if (variant === "sheet" && targetRepo === repoId) {
    return (
      <a
        className="underline"
        href={`?open=${encodeURIComponent(targetId)}`}
        onClick={(event) => {
          event.preventDefault();
          setOpenId(targetId);
        }}
      >
        {text}
      </a>
    );
  }
  return (
    <a className="underline" href={href}>
      {text}
    </a>
  );
}

function useInitiative(id: string): LoadState {
  const repoId = useRepoId();
  const [state, setState] = useState<LoadState>({ phase: "loading", data: null, message: null });

  useEffect(() => {
    const controller = new AbortController();
    setState({ phase: "loading", data: null, message: null });
    void fetch(repoApi(repoId, `/initiatives/${encodeURIComponent(id)}`), {
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (controller.signal.aborted) return;
        if (response.status === 401) {
          redirectToLogin();
          return;
        }
        const body: unknown = await response.json().catch(() => null);
        if (controller.signal.aborted) return;
        if (!response.ok || !isInitiativeDetails(body)) {
          setState({ phase: "error", data: null, message: messageFrom(body, response.status) });
          return;
        }
        setState({ phase: "ready", data: body, message: null });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          phase: "error",
          data: null,
          message: error instanceof Error ? error.message : "Could not load the initiative",
        });
      });
    return () => controller.abort();
  }, [id, repoId]);

  return state;
}

function isInitiativeDetails(value: unknown): value is InitiativeDetails {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.title === "string" &&
    typeof record.summary === "string" &&
    typeof record.sourceRef === "string" &&
    typeof record.path === "string" &&
    typeof record.updated === "string" &&
    Array.isArray(record.dependents) &&
    Array.isArray(record.onBranches)
  );
}

function isForge(value: unknown): value is ForgeLinkConfig {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === "github" &&
    typeof record.repo === "string" &&
    typeof record.fileUrl === "string" &&
    typeof record.prUrl === "string"
  );
}

function messageFrom(body: unknown, status: number): string {
  if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") {
    return body.error;
  }
  return `Could not load the initiative (${status})`;
}
