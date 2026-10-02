const REPO_ID = /^[a-z0-9-]{1,32}$/;
// Same grammar as the core schema (packages/core/src/schema.ts).
const INITIATIVE_ID = /^[a-z0-9_-]+-\d{3}$/;

export type QualifiedId = {
  repo: string;
  id: string;
};

/** `<repoId>:<project>-<NNN>`, for shared links and cross-repo dependency labels. */
export function formatQualifiedId(repo: string, id: string): string {
  return `${repo}:${id}`;
}

export function parseQualifiedId(text: string): QualifiedId | null {
  const separator = text.indexOf(":");
  if (separator <= 0) return null;
  const repo = text.slice(0, separator);
  const id = text.slice(separator + 1);
  if (!REPO_ID.test(repo) || !INITIATIVE_ID.test(id)) return null;
  return { repo, id };
}

/** Details path for a repo and initiative. Built through the qualified-id helpers. */
export function initiativeDetailsPath(repo: string, id: string): string {
  const parsed = parseQualifiedId(formatQualifiedId(repo, id));
  if (parsed === null) {
    return `/r/${encodeURIComponent(repo)}/initiatives/${encodeURIComponent(id)}`;
  }
  return `/r/${parsed.repo}/initiatives/${encodeURIComponent(parsed.id)}`;
}

export function shareUrl(origin: string, repo: string, id: string): string {
  return new URL(initiativeDetailsPath(repo, id), origin).toString();
}
