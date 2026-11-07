export const DOC_PARAM = "doc";
export const DOC_FORMAT_PARAM = "format";

export function currentOpenId(search = typeof window === "undefined" ? "" : window.location.search): string | null {
  const value = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("open");
  if (value === null || value.length === 0) return null;
  return value;
}

/** Document the viewer shows: `?doc=<key>` (`ROADMAP`, `reports/final.report`), optional `?format=html`, optional `#heading`. */
export type OpenDoc = {
  key: string;
  format: "md" | "html";
  anchor?: string;
};

export function currentOpenDoc(
  search = typeof window === "undefined" ? "" : window.location.search,
  hash = typeof window === "undefined" ? "" : window.location.hash,
): OpenDoc | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const key = parseDocKey(params.get(DOC_PARAM));
  if (key === null) return null;
  const format = params.get(DOC_FORMAT_PARAM) === "html" ? "html" : "md";
  const anchor = parseAnchor(hash);
  return anchor === undefined ? { key, format } : { key, format, anchor };
}

const STACK_KEY = "snoboardOpenStack";
export const MAX_OPEN_STACK = 20;

/** Initiatives the details panel came from (oldest first), kept in history.state. */
export function openStack(state: unknown = typeof window === "undefined" ? null : window.history.state): string[] {
  if (typeof state !== "object" || state === null) return [];
  const stack = (state as Record<string, unknown>)[STACK_KEY];
  return Array.isArray(stack) ? stack.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * Open `id` in the details panel (or close it with null) via a `?open=` pushState.
 * `fromDetails` keeps the current initiative on a small stack so "Back" returns to it.
 * Switching or closing drops `?doc=` — a document belongs to one initiative.
 */
export function setOpenId(id: string | null, options: { fromDetails?: boolean } = {}): void {
  if (typeof window === "undefined") return;
  const previous = currentOpenId();
  const params = new URLSearchParams(window.location.search);
  if (id === null || id.length === 0) params.delete("open");
  else params.set("open", id);
  const dropping = id === null || id.length === 0 || previous !== id;
  const hash = dropping ? applyDocParams(params, null) : window.location.hash;
  const query = params.toString();
  const next = `${window.location.pathname}${query.length === 0 ? "" : `?${query}`}${hash}`;
  const stack =
    options.fromDetails === true && previous !== null && id !== null && previous !== id
      ? [...openStack(), previous].slice(-MAX_OPEN_STACK)
      : [];
  const base = typeof window.history.state === "object" && window.history.state !== null ? window.history.state : {};
  window.history.pushState({ ...base, [STACK_KEY]: stack }, "", next);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** Open a document in the viewer (or close it with null) via `?doc=` / `?format=` / `#heading`. */
export function setOpenDoc(doc: OpenDoc | null): void {
  if (typeof window === "undefined") return;
  if (sameOpenDoc(currentOpenDoc(), doc)) return;
  const params = new URLSearchParams(window.location.search);
  const hash = applyDocParams(params, doc);
  const query = params.toString();
  const next = `${window.location.pathname}${query.length === 0 ? "" : `?${query}`}${hash}`;
  const base = typeof window.history.state === "object" && window.history.state !== null ? window.history.state : {};
  window.history.pushState({ ...base }, "", next);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/**
 * Path + query that opens `key` in the viewer on the current page (keeps `?open=` and filters).
 * Used as `href` so a document row can be copied or opened in a new tab.
 */
export function documentHref(key: string, options: { format?: "md" | "html"; anchor?: string } = {}): string {
  const params = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
  const hash = applyDocParams(params, {
    key,
    format: options.format ?? "md",
    ...(options.anchor === undefined ? {} : { anchor: options.anchor }),
  });
  const query = params.toString();
  const pathname = typeof window === "undefined" ? "" : window.location.pathname;
  return `${pathname}${query.length === 0 ? "" : `?${query}`}${hash}`;
}

/** Return to the previous initiative: a browser back, since every open pushed a history entry. */
export function goBackInDetails(): void {
  if (typeof window === "undefined" || openStack().length === 0) return;
  window.history.back();
}

export function initiativeIdOf(dependency: string): string {
  const hash = dependency.indexOf("#");
  if (hash === -1) return dependency;
  return dependency.slice(0, hash);
}

function applyDocParams(params: URLSearchParams, doc: OpenDoc | null): string {
  if (doc === null) {
    params.delete(DOC_PARAM);
    params.delete(DOC_FORMAT_PARAM);
    return "";
  }
  params.set(DOC_PARAM, doc.key);
  if (doc.format === "html") params.set(DOC_FORMAT_PARAM, "html");
  else params.delete(DOC_FORMAT_PARAM);
  if (doc.anchor === undefined || doc.anchor.length === 0) return "";
  return `#${encodeURIComponent(doc.anchor)}`;
}

function parseDocKey(value: string | null): string | null {
  if (value === null || value.length === 0 || value.length > 256) return null;
  if (value.includes("\\") || value.startsWith("/") || value.endsWith("/")) return null;
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) return null;
  return value;
}

function parseAnchor(hash: string): string | undefined {
  if (hash.length === 0 || hash === "#") return undefined;
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  return decoded.length === 0 || decoded.length > 256 ? undefined : decoded;
}

function sameOpenDoc(left: OpenDoc | null, right: OpenDoc | null): boolean {
  if (left === null && right === null) return true;
  if (left === null || right === null) return false;
  return left.key === right.key && left.format === right.format && (left.anchor ?? "") === (right.anchor ?? "");
}
