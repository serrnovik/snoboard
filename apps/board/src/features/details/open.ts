export function currentOpenId(search = typeof window === "undefined" ? "" : window.location.search): string | null {
  const value = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("open");
  if (value === null || value.length === 0) return null;
  return value;
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
 */
export function setOpenId(id: string | null, options: { fromDetails?: boolean } = {}): void {
  if (typeof window === "undefined") return;
  const previous = currentOpenId();
  const params = new URLSearchParams(window.location.search);
  if (id === null || id.length === 0) params.delete("open");
  else params.set("open", id);
  const query = params.toString();
  const next = `${window.location.pathname}${query.length === 0 ? "" : `?${query}`}${window.location.hash}`;
  const stack =
    options.fromDetails === true && previous !== null && id !== null && previous !== id
      ? [...openStack(), previous].slice(-MAX_OPEN_STACK)
      : [];
  const base = typeof window.history.state === "object" && window.history.state !== null ? window.history.state : {};
  window.history.pushState({ ...base, [STACK_KEY]: stack }, "", next);
  window.dispatchEvent(new PopStateEvent("popstate"));
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
