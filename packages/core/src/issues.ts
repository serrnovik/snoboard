export type IssueRef = {
  provider: string;
  key: string;
  raw: string;
};

export type ParsedIssueRef = IssueRef & {
  /** False when the prefix is not `gh`, `vj` or `vikunja`. The ref is still syntactically valid. */
  known: boolean;
};

const GH_NUMBER = /^gh#([1-9]\d*)$/;
const GH_QUALIFIED = /^gh:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9]\d*)$/;
const VIKUNJA = /^(?:vj|vikunja):([1-9]\d*)$/;
const KNOWN_PREFIX = /^(?:gh#|gh:|vj:|vikunja:)/;
const GENERIC = /^([a-z][a-z0-9_-]*):([^\s]+)$/;

function parsed(provider: string, key: string, raw: string, known: boolean): ParsedIssueRef {
  return { provider, key, raw, known };
}

/** Parses `gh#123`, `gh:owner/name#123`, `vj:456` (alias `vikunja:456`), or a generic `provider:key`. */
export function parseIssueRef(text: string): ParsedIssueRef | undefined {
  const ghNumber = GH_NUMBER.exec(text);
  if (ghNumber?.[1]) return parsed("gh", ghNumber[1], text, true);

  const ghQualified = GH_QUALIFIED.exec(text);
  if (ghQualified?.[1] && ghQualified[2]) {
    return parsed("gh", `${ghQualified[1]}#${ghQualified[2]}`, text, true);
  }

  const vikunja = VIKUNJA.exec(text);
  if (vikunja?.[1]) return parsed("vikunja", vikunja[1], text, true);

  if (KNOWN_PREFIX.test(text)) return undefined;

  const generic = GENERIC.exec(text);
  if (!generic?.[1] || !generic[2]) return undefined;
  return parsed(generic[1], generic[2], text, false);
}

/** Most issue refs an initiative may list. */
export const MAX_ISSUE_REFS = 30;

/** Short form for new entries: `vikunja:45` becomes `vj:45`. Other text is returned trimmed. */
export function normalizeIssueRef(text: string): string {
  const ref = text.trim();
  const vikunja = VIKUNJA.exec(ref);
  return vikunja?.[1] ? `vj:${vikunja[1]}` : ref;
}

/** Tracker settings needed to build links. Never contains credentials. */
export type IssueLinkConfig = {
  /** Vikunja site, for example `https://tasks.example.com`. */
  vikunjaBaseUrl?: string;
  /** GitHub `owner/name` that `gh#123` points at. */
  githubRepo?: string;
};

export type IssueUrlResult = { ref: string } | { error: string };

const GITHUB_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GITHUB_ISSUE_PATH = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(?:issues|pull)\/([1-9]\d*)\/?$/;
const VIKUNJA_TASK_PATH = /^\/tasks\/([1-9]\d*)\/?$/;

function parseUrl(text: string): URL | undefined {
  if (!/^https?:\/\//i.test(text)) return undefined;
  try {
    return new URL(text);
  } catch {
    return undefined;
  }
}

function trimSlash(path: string): string {
  return path.replace(/\/+$/, "");
}

/** `https://host/base` with no trailing slash, or undefined when not http(s). */
export function issueBaseUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const url = parseUrl(value.trim());
  if (url === undefined) return undefined;
  return `${url.origin}${trimSlash(url.pathname)}`;
}

/**
 * Turns a pasted tracker URL into a short ref. Returns undefined when `text` is not a URL.
 * A GitHub issue or pull request becomes `gh#12` for the configured repo, else `gh:owner/name#12`.
 * A Vikunja task becomes `vj:45` only when it is on the configured Vikunja site.
 */
export function issueRefFromUrl(text: string, config: IssueLinkConfig = {}): IssueUrlResult | undefined {
  const url = parseUrl(text.trim());
  if (url === undefined) return undefined;
  if (url.hostname.toLowerCase() === "github.com") {
    const match = GITHUB_ISSUE_PATH.exec(url.pathname);
    if (!match?.[1] || !match[2] || !match[3]) return { error: "Use a GitHub issue or pull request URL." };
    const repo = `${match[1]}/${match[2]}`;
    const own = config.githubRepo !== undefined && repo.toLowerCase() === config.githubRepo.trim().toLowerCase();
    return { ref: own ? `gh#${match[3]}` : `gh:${repo}#${match[3]}` };
  }
  const base = issueBaseUrl(config.vikunjaBaseUrl);
  if (base !== undefined) {
    const baseUrl = new URL(base);
    if (url.origin.toLowerCase() === baseUrl.origin.toLowerCase()) {
      const prefix = trimSlash(baseUrl.pathname);
      const path = url.pathname.startsWith(`${prefix}/`) ? url.pathname.slice(prefix.length) : undefined;
      const match = path === undefined ? null : VIKUNJA_TASK_PATH.exec(path);
      if (match?.[1]) return { ref: `vj:${match[1]}` };
      return { error: "Use a Vikunja task URL like /tasks/45." };
    }
  }
  return { error: `${url.host} is not this repository's GitHub or Vikunja site.` };
}

/** Browser link for a ref, built from config only. Empty when it cannot be built. */
export function issueLinkFor(raw: string, config: IssueLinkConfig = {}): string {
  const ref = parseIssueRef(raw.trim());
  if (ref === undefined || !ref.known) return "";
  if (ref.provider === "vikunja") {
    const base = issueBaseUrl(config.vikunjaBaseUrl);
    return base === undefined ? "" : `${base}/tasks/${ref.key}`;
  }
  const hash = ref.key.lastIndexOf("#");
  const repo = hash > 0 ? ref.key.slice(0, hash) : config.githubRepo?.trim();
  const number = hash > 0 ? ref.key.slice(hash + 1) : ref.key;
  if (repo === undefined || !GITHUB_REPO.test(repo)) return "";
  return `https://github.com/${repo}/issues/${number}`;
}
