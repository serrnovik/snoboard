import { IssueCreateError } from "./provider.js";

const MAX_MESSAGE = 200;

/** Removes every token occurrence and control characters, and caps the length. */
export function scrubTokens(text: string, tokens: readonly (string | undefined)[]): string {
  let result = text;
  for (const token of tokens) {
    if (token === undefined || token.length < 4) continue;
    result = result.split(token).join("[redacted]");
  }
  result = result.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return result.length > MAX_MESSAGE ? `${result.slice(0, MAX_MESSAGE)}…` : result;
}

/** Footer for trackers written with a board token: says who asked and for which initiative. */
export function snoboardFooter(body: string, createdBy: string, initiativeId: string): string {
  const who = createdBy.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200) || "unknown";
  const footer = `Created from Snoboard by ${who} for ${initiativeId}`;
  const trimmed = body.replace(/\s+$/, "");
  return trimmed.length === 0 ? footer : `${trimmed}\n\n---\n${footer}`;
}

/** Tracker message from a JSON error body, scrubbed. Empty when there is none. */
export async function upstreamMessage(response: Response, tokens: readonly (string | undefined)[]): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "message" in body && typeof body.message === "string") {
      return scrubTokens(body.message, tokens);
    }
  } catch {
    // Not JSON.
  }
  return "";
}

/** Maps a non-2xx tracker answer to an error. `forbidden` is the 403 text for this tracker. */
export async function createFailure(
  tracker: string,
  response: Response,
  tokens: readonly (string | undefined)[],
  forbidden: string,
): Promise<IssueCreateError> {
  const message = await upstreamMessage(response, tokens);
  const detail = message.length > 0 ? `: ${message}` : "";
  if (response.status === 401) return new IssueCreateError("auth", `${tracker} rejected the token`);
  if (response.status === 403) return new IssueCreateError("scope", forbidden);
  if (response.status === 404) return new IssueCreateError("not_found", `${tracker} target not found or not visible to the token`);
  if (response.status === 400 || response.status === 409 || response.status === 410 || response.status === 422) {
    return new IssueCreateError("rejected", `${tracker} refused the issue${detail}`);
  }
  return new IssueCreateError("upstream", `${tracker} answered ${response.status}`);
}

/** Network or redirect failure, without the underlying message (it may echo a URL or header). */
export function transportFailure(tracker: string, error: unknown): IssueCreateError {
  if (error instanceof IssueCreateError) return error;
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return new IssueCreateError("upstream", `${tracker} did not answer in time`);
  }
  return new IssueCreateError("upstream", `could not reach ${tracker}`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
