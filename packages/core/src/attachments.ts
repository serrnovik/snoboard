// No Node imports here: the browser bundle (snoboard/browser) uses these rules.

/** Largest single image attachment, in bytes. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
/** Most image attachments in one basket (and one submit). */
export const MAX_ATTACHMENTS = 10;
/** Most image bytes in one submit, before base64. Keeps the request under the submit body limit. */
export const MAX_ATTACHMENT_TOTAL_BYTES = 8 * 1024 * 1024;
/** Submit request body limit when it carries images (base64 grows bytes by a third). */
export const MAX_SUBMIT_BODY_BYTES = 12 * 1024 * 1024;

export const ATTACHMENT_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type AttachmentType = (typeof ATTACHMENT_TYPES)[number];

const EXTENSIONS: Record<AttachmentType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** `assets/<name>.<ext>`, relative to the initiative folder. Lowercase a-z, 0-9 and single hyphens. */
export const ASSET_PATH = /^assets\/([a-z0-9]+(?:-[a-z0-9]+)*)\.(png|jpg|webp|gif)$/;
/** A file name under `assets/`. */
export const ASSET_FILE = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.(png|jpg|webp|gif)$/;
/** `new:<project>/<slug>`: an initiative created in the same basket. */
export const NEW_INITIATIVE_REF = /^new:([a-z0-9][a-z0-9_-]*)\/([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const MAX_BASE_NAME = 60;

export function extensionFor(type: AttachmentType): string {
  return EXTENSIONS[type];
}

export function typeForExtension(extension: string): AttachmentType | undefined {
  const entry = (Object.entries(EXTENSIONS) as [AttachmentType, string][]).find(([, ext]) => ext === extension);
  return entry?.[0];
}

/** Image type from the first bytes. Only PNG, JPEG, WebP and GIF; never SVG or anything else. */
export function detectImageType(bytes: Uint8Array): AttachmentType | undefined {
  const at = (index: number): number => bytes[index] ?? -1;
  const ascii = (start: number, text: string): boolean =>
    [...text].every((char, offset) => at(start + offset) === char.charCodeAt(0));
  if (
    bytes.length >= 8 &&
    at(0) === 0x89 &&
    ascii(1, "PNG") &&
    at(4) === 0x0d &&
    at(5) === 0x0a &&
    at(6) === 0x1a &&
    at(7) === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && (ascii(0, "GIF87a") || ascii(0, "GIF89a"))) return "image/gif";
  if (bytes.length >= 12 && ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  return undefined;
}

/** A safe base name: lowercase a-z, 0-9 and single hyphens, at most 60 characters, never empty. */
export function safeAssetBaseName(name: string): string {
  const withoutExtension = name.replace(/\.[A-Za-z0-9]{1,5}$/, "");
  const cleaned = withoutExtension
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_BASE_NAME)
    .replace(/-+$/g, "");
  return cleaned.length === 0 ? "image" : cleaned;
}

/** `assets/<base>.<ext>`, with `-2`, `-3`, … appended until it is not in `taken`. */
export function uniqueAssetPath(name: string, type: AttachmentType, taken: ReadonlySet<string>): string {
  const base = safeAssetBaseName(name);
  const extension = extensionFor(type);
  let candidate = `assets/${base}.${extension}`;
  for (let suffix = 2; taken.has(candidate); suffix += 1) {
    candidate = `assets/${base}-${suffix}.${extension}`;
  }
  return candidate;
}
