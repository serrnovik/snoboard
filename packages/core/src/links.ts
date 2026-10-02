import { z } from "zod";

// No Node imports here: the browser bundle (snoboard/browser) uses these rules.

/** Most external links an initiative may list. */
export const MAX_LINKS = 20;
export const MAX_LINK_TITLE_LENGTH = 120;
export const MAX_LINK_URL_LENGTH = 2048;

export type ExternalLink = { title: string; url: string };

/** True for an absolute `https:` or `mailto:` URL of at most 2048 characters, with no whitespace or controls. */
export function isSafeLinkUrl(url: string): boolean {
  if (url.length === 0 || url.length > MAX_LINK_URL_LENGTH) return false;
  if (/[\s\u0000-\u001f\u007f]/.test(url)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return parsed.hostname.length > 0 && /^https:\/\//i.test(url);
  if (parsed.protocol === "mailto:") return /^mailto:[^/]/i.test(url);
  return false;
}

/** Why a link is not acceptable, or undefined when it is. */
export function linkProblem(link: { title: unknown; url: unknown }): string | undefined {
  if (typeof link.title !== "string" || link.title.trim().length === 0) return "title is empty";
  if (link.title.length > MAX_LINK_TITLE_LENGTH) return `title is longer than ${MAX_LINK_TITLE_LENGTH} characters`;
  if (/[\r\n]/.test(link.title)) return "title has a line break";
  if (typeof link.url !== "string" || link.url.length === 0) return "url is empty";
  if (link.url.length > MAX_LINK_URL_LENGTH) return `url is longer than ${MAX_LINK_URL_LENGTH} characters`;
  if (!isSafeLinkUrl(link.url)) return "url must be an https: or mailto: address";
  return undefined;
}

/** A valid link, as written by the editor. */
export const LinkSchema = z
  .object({ title: z.string(), url: z.string() })
  .strict()
  .superRefine((value, ctx) => {
    const problem = linkProblem(value);
    if (problem !== undefined) ctx.addIssue({ code: "custom", message: problem });
  });
