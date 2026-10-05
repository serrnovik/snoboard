// No Node imports here: the browser bundle (snoboard/browser) uses these rules.

/** Largest icon image, in bytes. */
export const MAX_ICON_BYTES = 256 * 1024;
/** Longest icon value (emoji or path), in characters. */
export const MAX_ICON_LENGTH = 200;

export const ICON_IMAGE_TYPES = ["image/png", "image/svg+xml", "image/webp", "image/x-icon"] as const;
export type IconImageType = (typeof ICON_IMAGE_TYPES)[number];

/** Label colours the board knows how to draw. Anything else is a validation warning. */
export const LABEL_COLORS = [
  "gray",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "teal",
  "cyan",
  "blue",
  "indigo",
  "violet",
  "purple",
  "pink",
  "rose",
] as const;
export type LabelColor = (typeof LABEL_COLORS)[number];

export type IconValue = { kind: "emoji"; value: string } | { kind: "image"; path: string };

/**
 * A repo-relative image path: plain ASCII segments, no `.`/`..` segments, no leading `/`,
 * ending in `.png`, `.svg`, `.webp` or `.ico`.
 */
const ICON_PATH = /^(?:[A-Za-z0-9_@+][A-Za-z0-9._@+-]*\/)*[A-Za-z0-9_@+][A-Za-z0-9._@+-]*\.(?:png|svg|webp|ico)$/;
const PICTOGRAPHIC = /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u;
const FORBIDDEN_IN_EMOJI = /[\p{L}\p{N}\p{P}\s<>]/u;
// Keycap, variation selector 16 and zero-width joiner, plus the keycap bases.
const EMOJI_JOINERS = new RegExp(`[${String.fromCharCode(0x20e3, 0xfe0f, 0x200d)}#*0-9]`, "gu");

function graphemes(value: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return [...segmenter.segment(value)].map((part) => part.segment);
  }
  return [...value];
}

/** True for one or two emoji grapheme clusters (for example `🧩`, `🇫🇷`, `👩‍💻`, `🛠️`). */
export function isEmojiIcon(value: string): boolean {
  if (value.length === 0 || value.length > 32 || value.trim() !== value) return false;
  const parts = graphemes(value);
  if (parts.length < 1 || parts.length > 2) return false;
  return parts.every((part) => PICTOGRAPHIC.test(part) && !FORBIDDEN_IN_EMOJI.test(part.replace(EMOJI_JOINERS, "")));
}

/** True for a repo-relative `.png` / `.svg` / `.webp` / `.ico` path without traversal. */
export function isIconPath(value: string): boolean {
  if (value.length === 0 || value.length > MAX_ICON_LENGTH) return false;
  if (!ICON_PATH.test(value)) return false;
  return value.split("/").every((segment) => segment !== "." && segment !== ".." && !segment.startsWith(".."));
}

/** Parses an icon value from config or frontmatter. `undefined` for anything else. */
export function parseIcon(value: unknown): IconValue | undefined {
  if (typeof value !== "string") return undefined;
  if (isEmojiIcon(value)) return { kind: "emoji", value };
  if (isIconPath(value)) return { kind: "image", path: value };
  return undefined;
}

/** Why an icon value is rejected, or `undefined` when it is fine. */
export function iconProblem(value: unknown, options?: { emojiOnly?: boolean }): string | undefined {
  if (typeof value !== "string") return "icon must be text";
  if (isEmojiIcon(value)) return undefined;
  if (options?.emojiOnly === true) return `icon "${shorten(value)}" must be one or two emoji`;
  if (isIconPath(value)) return undefined;
  return `icon "${shorten(value)}" must be one or two emoji or a repo-relative .png, .svg, .webp or .ico path`;
}

export function isLabelColor(value: unknown): value is LabelColor {
  return typeof value === "string" && (LABEL_COLORS as readonly string[]).includes(value);
}

/** Initiative icon first, then the project icon. */
export function resolveIcon(
  item: { icon?: unknown; project: string },
  projects: Readonly<Record<string, { icon?: unknown } | undefined>> | undefined,
): IconValue | undefined {
  return parseIcon(item.icon) ?? parseIcon(projects?.[item.project]?.icon);
}

/** Image type from the first bytes: PNG, WebP, ICO or SVG markup. */
export function detectIconType(bytes: Uint8Array): IconImageType | undefined {
  const at = (index: number): number => bytes[index] ?? -1;
  if (bytes.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47 && at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 &&
    at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50
  ) {
    return "image/webp";
  }
  if (bytes.length >= 6 && at(0) === 0 && at(1) === 0 && at(2) === 1 && at(3) === 0 && at(4) + at(5) * 256 > 0) {
    return "image/x-icon";
  }
  if (looksLikeSvg(bytes)) return "image/svg+xml";
  return undefined;
}

const BOM = String.fromCharCode(0xfeff);
const SVG_START = new RegExp(
  String.raw`^(?:${BOM})?\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE\s+svg[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]`,
  "i",
);

function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 4096));
  return SVG_START.test(head);
}

/** The icon type a path's extension promises. */
export function iconTypeForPath(path: string): IconImageType | undefined {
  const extension = /\.([a-z]+)$/.exec(path)?.[1];
  switch (extension) {
    case "png":
      return "image/png";
    case "svg":
      return "image/svg+xml";
    case "webp":
      return "image/webp";
    case "ico":
      return "image/x-icon";
    default:
      return undefined;
  }
}

function shorten(value: string): string {
  return value.length > 40 ? `${value.slice(0, 40)}…` : value;
}
