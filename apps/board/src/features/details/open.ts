export function currentOpenId(search = typeof window === "undefined" ? "" : window.location.search): string | null {
  const value = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("open");
  if (value === null || value.length === 0) return null;
  return value;
}

export function setOpenId(id: string | null): void {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  if (id === null || id.length === 0) params.delete("open");
  else params.set("open", id);
  const query = params.toString();
  const next = `${window.location.pathname}${query.length === 0 ? "" : `?${query}`}${window.location.hash}`;
  window.history.pushState(window.history.state, "", next);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function initiativeIdOf(dependency: string): string {
  const hash = dependency.indexOf("#");
  if (hash === -1) return dependency;
  return dependency.slice(0, hash);
}
