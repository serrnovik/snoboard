import { lazy, Suspense, type ReactNode } from "react";

export type ReportMarkdownProps = {
  markdown: string;
  /** Image `src` to load, or "" to block it. */
  resolveImage: (src: string) => string;
  /** Renders one link; the raw `href` from the markdown is passed through untouched. */
  renderLink: (href: string, children: ReactNode) => ReactNode;
};

// Shares the editor's markdown chunk; loaded only when a report is opened.
const LazyReportMarkdown = lazy(() => import("./report-markdown-impl"));

/** Full markdown (GFM tables, task lists) for reports, sanitized like the editor preview. */
export function ReportMarkdown(props: ReportMarkdownProps) {
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground">Loading report…</p>}>
      <LazyReportMarkdown {...props} />
    </Suspense>
  );
}
