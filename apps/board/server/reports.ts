import {
  detectImageType,
  isReportFile,
  MAX_ATTACHMENT_BYTES,
  MAX_REPORT_BYTES,
  type BoardItem,
  type Snapshot,
} from "snoboard";
import { readCommittedBytes } from "./repo-sync.js";

/** Headers for every report answer, including errors. */
const BASE_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "private, no-store",
};

/**
 * HTML reports render as static documents: no scripts (CSP plus `sandbox`), no network
 * (only inline styles and `data:` images), and only the board itself may frame them.
 */
export const HTML_REPORT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox; frame-ancestors 'self'; base-uri 'none'; form-action 'none'";

const MARKDOWN_REPORT_CSP = "default-src 'none'; sandbox";

/** An image next to the reports (`reports/shot.png`, `reports/visuals/a.png`); plain ASCII names. */
const REPORT_IMAGE = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,127}\/)?[A-Za-z0-9_][A-Za-z0-9._-]{0,127}\.(?:png|jpe?g|webp|gif)$/;

export type ReportLookup =
  | { ok: true; path: string; kind: "md" | "html" | "image"; sha: string }
  | { ok: false };

function sourceSha(snapshot: Snapshot, item: BoardItem): string | undefined {
  return snapshot.refs.find((ref) => ref.name === item.sourceRef)?.sha;
}

function reportsFolder(item: BoardItem): string {
  return `${item.path.slice(0, item.path.lastIndexOf("/"))}/reports`;
}

/**
 * Resolves `relative` (path below `reports/`, with extension) for an initiative. A report must
 * be one the snapshot listed from the tree (regular `.md` / `.html` files, at most one folder
 * deep), so traversal, symlinks and other extensions never reach git. Images below `reports/`
 * must match a strict name pattern and are answered only when their bytes are an image.
 */
export function lookupReport(snapshot: Snapshot, item: BoardItem, relative: string): ReportLookup {
  const sha = sourceSha(snapshot, item);
  if (sha === undefined || (item.reports ?? []).length === 0) return { ok: false };
  if (REPORT_IMAGE.test(relative)) {
    if (relative.includes("..")) return { ok: false };
    return { ok: true, path: `${reportsFolder(item)}/${relative}`, kind: "image", sha };
  }
  if (!isReportFile(relative)) return { ok: false };
  const match = /^(.+)\.(md|html)$/.exec(relative);
  if (match === null) return { ok: false };
  const name = match[1] ?? "";
  const kind = match[2] as "md" | "html";
  const entry = item.reports?.find((report) => report.name === name);
  if (entry === undefined || !entry.formats.includes(kind)) return { ok: false };
  return { ok: true, path: `${reportsFolder(item)}/${relative}`, kind, sha };
}

export function reportNotFound(): Response {
  return new Response(JSON.stringify({ error: "not found" }), {
    status: 404,
    headers: {
      ...BASE_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'",
    },
  });
}

/** Reads the file (fetched on demand from a blob-less clone) and answers it with locked-down headers. */
export async function reportResponse(repoDir: string, found: Extract<ReportLookup, { ok: true }>): Promise<Response> {
  const limit = found.kind === "image" ? MAX_ATTACHMENT_BYTES : MAX_REPORT_BYTES;
  const bytes = await readCommittedBytes(repoDir, found.sha, found.path, limit).catch(() => undefined);
  if (bytes === undefined) return reportNotFound();
  let contentType: string;
  let csp: string;
  if (found.kind === "image") {
    const type = detectImageType(bytes);
    if (type === undefined) return reportNotFound();
    contentType = type;
    csp = "default-src 'none'";
  } else if (found.kind === "html") {
    contentType = "text/html; charset=utf-8";
    csp = HTML_REPORT_CSP;
  } else {
    // Markdown is served as plain text: the browser never interprets it.
    contentType = "text/plain; charset=utf-8";
    csp = MARKDOWN_REPORT_CSP;
  }
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      ...BASE_HEADERS,
      "Content-Type": contentType,
      "Content-Length": String(bytes.length),
      "Content-Disposition": "inline",
      "Content-Security-Policy": csp,
    },
  });
}
