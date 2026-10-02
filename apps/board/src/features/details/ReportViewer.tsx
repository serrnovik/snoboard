import { ChevronLeft, ChevronRight, ExternalLink, FileText } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { BoardItem } from "snoboard/browser";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ReportMarkdown } from "@/components/report-markdown";
import { redirectToLogin } from "@/features/board/sync";
import type { ForgeLinkConfig } from "./links.js";
import {
  defaultFormat,
  forgeReportUrl,
  orderedReports,
  reportFileUrl,
  reportImageSrc,
  reportLinkTarget,
  type Report,
  type ReportFormat,
} from "./report-links.js";

type ReportItem = Pick<BoardItem, "id" | "path" | "sourceRef" | "reports" | "phases">;

export type ReportSelection = { index: number; format: ReportFormat };

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
  onOpen: (report: Report) => void;
}) {
  return (
    <button
      type="button"
      className={chipClass}
      data-testid={`report-chip-${report.name}`}
      title={`${report.name} (${report.formats.join(", ")})`}
      onClick={() => onOpen(report)}
    >
      <FileText aria-hidden="true" className="size-3 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

/** Large report viewer: markdown rendered by the board, HTML in a script-less sandboxed frame. */
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
  const reports = orderedReports(item);
  const report = selection === null ? undefined : reports[selection.index];
  const format = report === undefined || selection === null ? "md" : report.formats.includes(selection.format) ? selection.format : defaultFormat(report);
  const count = reports.length;
  const index = selection?.index ?? 0;
  const go = (next: number) => {
    const target = reports[next];
    if (target !== undefined) onSelect({ index: next, format: defaultFormat(target) });
  };
  const raw = report === undefined ? null : forgeReportUrl(forge, item, report, format);
  return (
    <Dialog
      open={report !== undefined}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        data-testid="report-dialog"
        className="flex h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-none! flex-col gap-3 overflow-hidden p-0 sm:max-w-[min(calc(100vw-2rem),1400px)]!"
        onKeyDown={(event) => {
          if (event.target instanceof HTMLElement && event.target.closest("input,textarea,select")) return;
          if (event.key === "ArrowLeft" && index > 0) go(index - 1);
          if (event.key === "ArrowRight" && index < count - 1) go(index + 1);
        }}
      >
        {report !== undefined ? (
          <>
            <header className="flex flex-wrap items-center gap-2 border-b px-4 py-3 pr-12">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  aria-label="Previous report"
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
                  aria-label="Next report"
                  data-testid="report-next"
                  disabled={index >= count - 1}
                  onClick={() => go(index + 1)}
                  className="rounded-md p-1 hover:bg-muted disabled:opacity-40"
                >
                  <ChevronRight aria-hidden="true" className="size-4" />
                </button>
              </div>
              <div className="min-w-0 flex-1">
                <DialogTitle className="truncate font-mono text-sm">{report.name}</DialogTitle>
                <DialogDescription className="text-xs">
                  {item.id}
                  {report.phase !== undefined ? ` · phase ${report.phase}` : ""}
                </DialogDescription>
              </div>
              {report.formats.length > 1 ? (
                <div role="group" aria-label="Format" className="inline-flex rounded-md border text-xs">
                  {report.formats.map((option) => (
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
                  Open raw on GitHub
                  <ExternalLink aria-hidden="true" className="size-3" />
                </a>
              ) : null}
            </header>
            <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
              {format === "html" ? (
                <HtmlReport src={reportFileUrl(repoId, item.id, `${report.name}.html`)} title={report.name} />
              ) : (
                <MarkdownReport
                  item={item}
                  repoId={repoId}
                  forge={forge}
                  report={report}
                  reports={reports}
                  onSelect={onSelect}
                />
              )}
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
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

function MarkdownReport({
  item,
  repoId,
  forge,
  report,
  reports,
  onSelect,
}: {
  item: ReportItem;
  repoId: string;
  forge: ForgeLinkConfig;
  report: Report;
  reports: readonly Report[];
  onSelect: (selection: ReportSelection) => void;
}) {
  const [state, setState] = useState<MarkdownState>({ phase: "loading", text: "" });
  const url = reportFileUrl(repoId, item.id, `${report.name}.md`);
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
          setState({ phase: "error", text: `Could not load the report (${response.status})` });
          return;
        }
        const text = await response.text();
        if (!controller.signal.aborted) setState({ phase: "ready", text });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ phase: "error", text: "Could not load the report" });
      });
    return () => controller.abort();
  }, [url]);

  const folder = item.path.slice(0, item.path.lastIndexOf("/"));
  const renderLink = useCallback(
    (href: string, children: ReactNode) => {
      const target = reportLinkTarget(href, { name: report.name, reports, forge, sourceRef: item.sourceRef, folder });
      if (target.kind === "report") {
        return (
          <a
            href={href}
            data-report-link=""
            // The client router would otherwise navigate to the raw relative path.
            data-vike="false"
            onClick={(event) => {
              event.preventDefault();
              onSelect({ index: target.index, format: target.format });
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
      if (target.kind === "anchor") return <a href={target.href}>{children}</a>;
      return <span className="underline decoration-dotted">{children}</span>;
    },
    [report.name, reports, forge, item.sourceRef, folder, onSelect],
  );

  if (state.phase === "loading") return <p className="py-4 text-sm text-muted-foreground">Loading report…</p>;
  if (state.phase === "error") {
    return (
      <p role="alert" className="my-4 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
        {state.text}
      </p>
    );
  }
  return (
    <ReportMarkdown
      markdown={state.text}
      resolveImage={(src) => reportImageSrc(src, { repoId, id: item.id, name: report.name })}
      renderLink={renderLink}
    />
  );
}

/**
 * "Reports" section of the details panel (initiative-level reports) plus the dialog. Phase
 * reports show as chips in the phase table through `openReport`.
 */
export function useReportViewer(item: ReportItem) {
  const [selection, setSelection] = useState<ReportSelection | null>(null);
  const reports = orderedReports(item);
  const openReport = (report: Report) => {
    const index = reports.findIndex((entry) => entry.name === report.name);
    if (index !== -1) setSelection({ index, format: defaultFormat(report) });
  };
  return { selection, setSelection, openReport };
}

export function ReportsSection({
  reports,
  onOpen,
}: {
  reports: readonly Report[];
  onOpen: (report: Report) => void;
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
              onClick={() => onOpen(report)}
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
