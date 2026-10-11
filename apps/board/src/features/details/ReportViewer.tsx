import { ChevronDown, ChevronLeft, ChevronRight, ExternalLink, FileText, ListChecks } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { BoardItem } from "snoboard/browser";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ReportMarkdown } from "@/components/report-markdown";
import { redirectToLogin } from "@/features/board/sync";
import type { ForgeLinkConfig } from "./links.js";
import type { Report } from "./report-links.js";
import {
  defaultDocFormat,
  docChipLabel,
  docFileUrl,
  docImageSrc,
  docLinkTarget,
  findAnchor,
  forgeDocUrl,
  groupViewerDocs,
  viewerDocs,
  type DocEntry,
  type DocFormat,
  type ViewerDoc,
} from "./doc-links.js";

type ReportItem = Pick<BoardItem, "id" | "path" | "sourceRef" | "reports" | "docs" | "phases">;

/** The open document (index into `viewerDocs(item)`), its format and an optional `#anchor` to scroll to. */
export type ReportSelection = { index: number; format: DocFormat; anchor?: string };

const chipClass =
  "inline-flex max-w-full items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

/** A button that opens one report in the dialog. */
export function ReportChip({
  report,
  label,
  onOpen,
}: {
  report: Report;
  label: string;
  onOpen: (key: string) => void;
}) {
  return (
    <button
      type="button"
      className={chipClass}
      data-testid={`report-chip-${report.name}`}
      title={`${report.name} (${report.formats.join(", ")})`}
      onClick={() => onOpen(`reports/${report.name}`)}
    >
      <FileText aria-hidden="true" className="size-3 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

/** Chips for a phase's documents: packets and other phase files, then an expandable "N tasks". */
export function PhaseDocChips({
  phase,
  docs,
  onOpen,
}: {
  phase: number;
  docs: readonly DocEntry[];
  onOpen: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (docs.length === 0) return null;
  const files = docs.filter((doc) => doc.kind !== "task");
  const tasks = docs.filter((doc) => doc.kind === "task");
  const chip = (doc: DocEntry) => (
    <button
      key={doc.path}
      type="button"
      className={chipClass}
      data-testid={`doc-chip-${doc.path}`}
      title={`${doc.path} (${doc.formats.join(", ")})`}
      onClick={() => onOpen(doc.path)}
    >
      <FileText aria-hidden="true" className="size-3 shrink-0" />
      <span className="truncate">{docChipLabel(doc)}</span>
    </button>
  );
  return (
    <span className="mt-1 flex flex-col gap-1" data-testid={`phase-docs-${phase}`}>
      <span className="flex flex-wrap gap-1">
        {files.map(chip)}
        {tasks.length > 0 ? (
          <button
            type="button"
            className={chipClass}
            aria-expanded={open}
            data-testid={`phase-tasks-toggle-${phase}`}
            onClick={() => setOpen((value) => !value)}
          >
            <ListChecks aria-hidden="true" className="size-3 shrink-0" />
            {tasks.length === 1 ? "1 task" : `${tasks.length} tasks`}
            <ChevronDown aria-hidden="true" className={`size-3 transition-transform ${open ? "rotate-180" : ""}`} />
          </button>
        ) : null}
      </span>
      {open ? (
        <span className="flex flex-wrap gap-1" data-testid={`phase-tasks-${phase}`}>
          {tasks.map(chip)}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Large document viewer: a navigation tree of the initiative's documents (Initiative, Phase N,
 * Reports) next to the content; markdown rendered by the board, HTML in a script-less sandboxed frame.
 */
export function ReportDialog({
  item,
  repoId,
  forge,
  selection,
  onSelect,
  onClose,
}: {
  item: ReportItem;
  repoId: string;
  forge: ForgeLinkConfig;
  selection: ReportSelection | null;
  onSelect: (selection: ReportSelection) => void;
  onClose: () => void;
}) {
  const docs = viewerDocs(item);
  const doc = selection === null ? undefined : docs[selection.index];
  const format =
    doc === undefined || selection === null ? "md" : doc.formats.includes(selection.format) ? selection.format : defaultDocFormat(doc);
  const count = docs.length;
  const index = selection?.index ?? 0;
  const go = (next: number) => {
    const target = docs[next];
    if (target !== undefined) onSelect({ index: next, format: defaultDocFormat(target) });
  };
  const raw = doc === undefined ? null : forgeDocUrl(forge, item, doc, format);
  return (
    <Dialog
      open={doc !== undefined}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        data-testid="report-dialog"
        className="flex h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-none! flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(calc(100vw-2rem),1400px)]!"
        onKeyDown={(event) => {
          if (event.target instanceof HTMLElement && event.target.closest("input,textarea,select")) return;
          if (event.key === "ArrowLeft" && index > 0) go(index - 1);
          if (event.key === "ArrowRight" && index < count - 1) go(index + 1);
        }}
      >
        {doc !== undefined ? (
          <>
            <header className="flex flex-wrap items-center gap-2 border-b px-4 py-3 pr-12">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  aria-label="Previous document"
                  data-testid="report-prev"
                  disabled={index === 0}
                  onClick={() => go(index - 1)}
                  className="rounded-md p-1 hover:bg-muted disabled:opacity-40"
                >
                  <ChevronLeft aria-hidden="true" className="size-4" />
                </button>
                <span className="text-xs text-muted-foreground tabular-nums" data-testid="report-position">
                  {index + 1} / {count}
                </span>
                <button
                  type="button"
                  aria-label="Next document"
                  data-testid="report-next"
                  disabled={index >= count - 1}
                  onClick={() => go(index + 1)}
                  className="rounded-md p-1 hover:bg-muted disabled:opacity-40"
                >
                  <ChevronRight aria-hidden="true" className="size-4" />
                </button>
              </div>
              <div className="min-w-0 flex-1">
                <DialogTitle className="truncate font-mono text-sm">{doc.key}</DialogTitle>
                <DialogDescription className="text-xs">
                  {item.id}
                  {doc.phase !== undefined ? ` · phase ${doc.phase}` : ""}
                  {doc.kind === "task" ? " · task" : ""}
                </DialogDescription>
              </div>
              {doc.formats.length > 1 ? (
                <div role="group" aria-label="Format" className="inline-flex rounded-md border text-xs">
                  {doc.formats.map((option) => (
                    <button
                      key={option}
                      type="button"
                      aria-pressed={option === format}
                      data-testid={`report-format-${option}`}
                      onClick={() => onSelect({ index, format: option })}
                      className="px-2 py-1 uppercase aria-pressed:bg-muted aria-pressed:font-medium"
                    >
                      {option}
                    </button>
                  ))}
                </div>
              ) : null}
              {raw !== null ? (
                <a
                  href={raw}
                  rel="noopener noreferrer"
                  target="_blank"
                  data-testid="report-raw"
                  className="inline-flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline"
                >
                  Open on GitHub
                  <ExternalLink aria-hidden="true" className="size-3" />
                </a>
              ) : null}
            </header>
            <div className="flex min-h-0 flex-1">
              <DocNav docs={docs} index={index} onOpen={go} />
              <div className="min-h-0 min-w-0 flex-1 overflow-auto px-4 py-3" data-testid="doc-content">
                {format === "html" ? (
                  <HtmlReport src={docFileUrl(repoId, item.id, `${doc.key}.html`)} title={doc.key} />
                ) : (
                  <MarkdownDoc
                    item={item}
                    repoId={repoId}
                    forge={forge}
                    doc={doc}
                    docs={docs}
                    anchor={selection?.anchor}
                    onSelect={onSelect}
                  />
                )}
              </div>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** Left navigation tree of the viewer; hidden on narrow screens (prev / next still work). */
function DocNav({ docs, index, onOpen }: { docs: readonly ViewerDoc[]; index: number; onOpen: (index: number) => void }) {
  return (
    <nav
      aria-label="Documents"
      data-testid="doc-nav"
      className="hidden w-60 shrink-0 overflow-auto border-r px-2 py-3 text-xs md:block"
    >
      {groupViewerDocs(docs).map(({ group, entries }) => (
        <div key={group} className="mb-3">
          <h3 className="px-2 pb-1 font-medium text-muted-foreground">{group}</h3>
          <ul className="flex flex-col">
            {entries.map(({ doc, index: entryIndex }) => (
              <li key={doc.key}>
                <button
                  type="button"
                  data-testid={`doc-nav-${doc.key}`}
                  aria-current={entryIndex === index ? "page" : undefined}
                  title={doc.key}
                  onClick={() => onOpen(entryIndex)}
                  className={`w-full truncate rounded-md px-2 py-1 text-left font-mono hover:bg-muted aria-[current=page]:bg-muted aria-[current=page]:font-medium ${doc.kind === "task" ? "pl-5" : ""}`}
                >
                  {doc.kind === "report" ? doc.key.slice("reports/".length) : doc.title}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/**
 * HTML twins render with no scripts, no same-origin access, no forms, no popups and no
 * top navigation: `sandbox=""` plus the endpoint's CSP (no network, inline styles only).
 */
export function HtmlReport({ src, title }: { src: string; title: string }) {
  return (
    <iframe
      data-testid="report-frame"
      src={src}
      title={title}
      sandbox=""
      referrerPolicy="no-referrer"
      loading="lazy"
      className="h-full min-h-[60vh] w-full rounded-md border bg-white"
    />
  );
}

type MarkdownState = { phase: "loading" | "error" | "ready"; text: string };

function scrollToAnchor(root: HTMLElement | null, id: string): void {
  if (root === null) return;
  const target = findAnchor(root, id);
  if (target !== null && typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "start" });
}

function MarkdownDoc({
  item,
  repoId,
  forge,
  doc,
  docs,
  anchor,
  onSelect,
}: {
  item: ReportItem;
  repoId: string;
  forge: ForgeLinkConfig;
  doc: ViewerDoc;
  docs: readonly ViewerDoc[];
  anchor: string | undefined;
  onSelect: (selection: ReportSelection) => void;
}) {
  const [state, setState] = useState<MarkdownState>({ phase: "loading", text: "" });
  const root = useRef<HTMLDivElement>(null);
  const url = docFileUrl(repoId, item.id, `${doc.key}.md`);
  useEffect(() => {
    const controller = new AbortController();
    setState({ phase: "loading", text: "" });
    void fetch(url, { credentials: "same-origin", signal: controller.signal })
      .then(async (response) => {
        if (controller.signal.aborted) return;
        if (response.status === 401) {
          redirectToLogin();
          return;
        }
        if (!response.ok) {
          setState({ phase: "error", text: `Could not load the document (${response.status})` });
          return;
        }
        const text = await response.text();
        if (!controller.signal.aborted) setState({ phase: "ready", text });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ phase: "error", text: "Could not load the document" });
      });
    return () => controller.abort();
  }, [url]);

  // A link like `phase-1.packet.md#scope` lands on the heading once the markdown has rendered.
  useEffect(() => {
    if (state.phase !== "ready" || anchor === undefined) return;
    const frame = requestAnimationFrame(() => scrollToAnchor(root.current, anchor));
    return () => cancelAnimationFrame(frame);
  }, [state.phase, anchor, state.text]);

  const folder = item.path.slice(0, item.path.lastIndexOf("/"));
  const renderLink = useCallback(
    (href: string, children: ReactNode) => {
      const target = docLinkTarget(href, { from: doc.key, docs, forge, sourceRef: item.sourceRef, folder });
      if (target.kind === "doc") {
        return (
          <a
            href={href}
            data-report-link=""
            // The client router would otherwise navigate to the raw relative path.
            data-vike="false"
            onClick={(event) => {
              event.preventDefault();
              if (target.index === docs.indexOf(doc) && target.format === "md" && target.anchor !== undefined) {
                scrollToAnchor(root.current, target.anchor);
              }
              onSelect(
                target.anchor === undefined
                  ? { index: target.index, format: target.format }
                  : { index: target.index, format: target.format, anchor: target.anchor },
              );
            }}
          >
            {children}
          </a>
        );
      }
      if (target.kind === "external") {
        return (
          <a href={target.href} rel="noopener noreferrer" target="_blank">
            {children}
          </a>
        );
      }
      if (target.kind === "anchor") {
        return (
          <a
            href={`#${target.id}`}
            data-vike="false"
            onClick={(event) => {
              event.preventDefault();
              scrollToAnchor(root.current, target.id);
            }}
          >
            {children}
          </a>
        );
      }
      return <span className="underline decoration-dotted">{children}</span>;
    },
    [doc, docs, forge, item.sourceRef, folder, onSelect],
  );

  if (state.phase === "loading") return <p className="py-4 text-sm text-muted-foreground">Loading document…</p>;
  if (state.phase === "error") {
    return (
      <p role="alert" className="my-4 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
        {state.text}
      </p>
    );
  }
  return (
    <div ref={root}>
      <ReportMarkdown
        markdown={state.text}
        resolveImage={(src) => docImageSrc(src, { repoId, id: item.id, from: doc.key })}
        renderLink={renderLink}
      />
    </div>
  );
}

/**
 * State of the document viewer. `openDoc` takes a key from `viewerDocs` (`ROADMAP`,
 * `phases/phase-1.packet`, `reports/final.report`).
 */
export function useReportViewer(item: ReportItem) {
  const [selection, setSelection] = useState<ReportSelection | null>(null);
  const docs = viewerDocs(item);
  const openDoc = (key: string) => {
    const index = docs.findIndex((entry) => entry.key === key);
    const doc = docs[index];
    if (doc !== undefined) setSelection({ index, format: defaultDocFormat(doc) });
  };
  return { selection, setSelection, openDoc };
}

/** "Documents" section of the details panel: initiative-level documents (ROADMAP, CONVENTIONS, phases/README, ...). */
export function DocumentsSection({ docs, onOpen }: { docs: readonly DocEntry[]; onOpen: (key: string) => void }) {
  if (docs.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" data-testid="docs-section">
      <h2 className="text-sm font-medium">Documents</h2>
      <ul className="flex flex-col gap-1 text-sm">
        {docs.map((doc) => (
          <li key={doc.path} className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              data-testid={`doc-open-${doc.path}`}
              onClick={() => onOpen(doc.path)}
              className="inline-flex min-w-0 items-center gap-1 text-left text-primary underline-offset-4 hover:underline"
            >
              <FileText aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="truncate font-mono text-xs">{doc.path}</span>
            </button>
            <span className="text-xs text-muted-foreground">{doc.formats.join(" · ")}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ReportsSection({
  reports,
  onOpen,
}: {
  reports: readonly Report[];
  onOpen: (key: string) => void;
}) {
  if (reports.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" data-testid="reports-section">
      <h2 className="text-sm font-medium">Reports</h2>
      <ul className="flex flex-col gap-1 text-sm">
        {reports.map((report) => (
          <li key={report.name} className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              data-testid={`report-open-${report.name}`}
              onClick={() => onOpen(`reports/${report.name}`)}
              className="inline-flex min-w-0 items-center gap-1 text-left text-primary underline-offset-4 hover:underline"
            >
              <FileText aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="truncate font-mono text-xs">{report.name}</span>
            </button>
            <span className="text-xs text-muted-foreground">{report.formats.join(" · ")}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
