export const ISSUE_CREATE_LIMIT_PER_HOUR = 20;
/** 20 000 characters of body can be up to 80 KB of UTF-8, plus the JSON around it. */
export const ISSUE_CREATE_MAX_BODY_BYTES = 96 * 1024;
export const ISSUE_TITLE_MAX = 256;
export const ISSUE_BODY_MAX = 20_000;
export const ISSUE_CREATE_TIMEOUT_MS = 15_000;

const HOUR_MS = 60 * 60 * 1000;
const PROVIDERS = new Set(["gh", "fj", "vikunja"]);
const INITIATIVE_ID = /^[A-Za-z0-9_.-]{1,80}$/;

const createStamps = new Map<string, number[]>();

export function resetIssueCreateLimits(): void {
  createStamps.clear();
}

/** Counts this attempt. False once the person used up their issue creations for the hour. */
export function allowIssueCreate(subject: string, now: number): boolean {
  const recent = (createStamps.get(subject) ?? []).filter((stamp) => now - stamp < HOUR_MS);
  if (recent.length >= ISSUE_CREATE_LIMIT_PER_HOUR) {
    createStamps.set(subject, recent);
    return false;
  }
  recent.push(now);
  createStamps.set(subject, recent);
  return true;
}

export type IssueCreateBody = {
  provider: string;
  initiativeId: string;
  title: string;
  body: string;
  csrf: unknown;
  /** Vikunja only: chosen project. */
  projectId?: number;
};

/** Parses and checks the request. Title: 1..256 characters on one line; body: at most 20 000 characters. */
export function parseIssueCreateBody(raw: string): IssueCreateBody | { error: string } {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { error: "invalid json" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { error: "invalid request" };
  const record = value as Record<string, unknown>;
  const { provider, initiativeId, title, body } = record;
  if (typeof provider !== "string" || !PROVIDERS.has(provider)) return { error: "unknown provider" };
  if (typeof initiativeId !== "string" || !INITIATIVE_ID.test(initiativeId)) return { error: "invalid initiative id" };
  if (typeof title !== "string") return { error: "title is required" };
  const trimmedTitle = title.trim();
  if (trimmedTitle.length === 0) return { error: "title is required" };
  if ([...trimmedTitle].length > ISSUE_TITLE_MAX) return { error: `title is longer than ${ISSUE_TITLE_MAX} characters` };
  if (/[\u0000-\u001f\u007f]/.test(trimmedTitle)) return { error: "title must be one line" };
  const text = body === undefined ? "" : body;
  if (typeof text !== "string") return { error: "body must be text" };
  if ([...text].length > ISSUE_BODY_MAX) return { error: `body is longer than ${ISSUE_BODY_MAX} characters` };
  if (text.includes("\u0000")) return { error: "body must be text" };
  const projectId = record.projectId;
  if (projectId !== undefined && projectId !== null) {
    if (provider !== "vikunja") return { error: "projectId is only for Vikunja" };
    if (typeof projectId !== "number" || !Number.isInteger(projectId) || projectId < 1) return { error: "invalid projectId" };
  }
  return {
    provider,
    initiativeId,
    title: trimmedTitle,
    body: text,
    csrf: record.csrf,
    ...(typeof projectId === "number" ? { projectId } : {}),
  };
}

/**
 * One info line per attempt: outcome, reason, who, provider, initiative and, on success, the ref.
 * Never the title, body or a token. Values are JSON-quoted so a crafted name cannot forge a line.
 */
export function logIssueCreate(input: {
  outcome: "denied" | "failed" | "ok";
  reason: string;
  user: string;
  actor: string;
  repo: string;
  provider?: string;
  initiative?: string;
  ref?: string;
}): void {
  const parts = [
    `snoboard: issue-create ${input.outcome}`,
    `reason=${JSON.stringify(input.reason)}`,
    `user=${JSON.stringify(input.user.slice(0, 200))}`,
    `actor=${input.actor}`,
    `repo=${JSON.stringify(input.repo.slice(0, 40))}`,
  ];
  if (input.provider !== undefined) parts.push(`provider=${JSON.stringify(input.provider.slice(0, 20))}`);
  if (input.initiative !== undefined) parts.push(`initiative=${JSON.stringify(input.initiative.slice(0, 80))}`);
  if (input.ref !== undefined) parts.push(`ref=${JSON.stringify(input.ref.slice(0, 40))}`);
  console.info(parts.join(" "));
}
