import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ASSET_PATH,
  detectImageType,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_TOTAL_BYTES,
  MAX_ATTACHMENTS,
  uniqueAssetPath,
  type AttachmentType,
  type Edit,
} from "snoboard/browser";
import { useBasket } from "@/features/basket/store";
import { repoApi } from "@/lib/routes";
import { deleteImage, getImage, newImageKey, putImage } from "./store";

type AttachmentEdit = Extract<Edit, { kind: "addAttachment" }>;

export type PendingImage = {
  key: string;
  path: string;
  contentType: AttachmentType;
  sha256: string;
  size: number;
  name: string;
};

/** What the markdown editor needs to accept and preview images. */
export type EditorImages = {
  attach: (files: readonly File[]) => Promise<{ markdown: string; error?: string }>;
  /** Image `src` to show in the preview, or "" to block it. */
  resolve: (src: string) => string;
};

const MB = 1024 * 1024;

/** `assets/<file>` (optionally `./assets/<file>`) or undefined. Remote and other paths never match. */
export function assetPathOf(src: string): string | undefined {
  const trimmed = src.trim().replace(/^\.\//, "");
  return ASSET_PATH.test(trimmed) ? trimmed : undefined;
}

/** The authenticated endpoint that serves a committed image of initiative `id`. */
export function assetUrl(repoId: string, id: string, path: string): string {
  const file = path.slice("assets/".length);
  return repoApi(repoId, `/initiatives/${encodeURIComponent(id)}/assets/${encodeURIComponent(file)}`);
}

/**
 * Preview rule for images: only relative `assets/<file>` paths are shown. Pending images
 * use their local object URL; committed ones use the asset endpoint. Everything else
 * (remote URLs, data:, other paths) is blocked.
 */
export function resolveImageSrc(
  src: string,
  context: { repoId: string; id?: string; pending?: ReadonlyMap<string, string> },
): string {
  const path = assetPathOf(src);
  if (path === undefined) return "";
  const local = context.pending?.get(path);
  if (local !== undefined) return local;
  if (context.id === undefined) return "";
  return assetUrl(context.repoId, context.id, path);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Reads and checks one file: type by magic bytes, size. */
export async function readImageFile(
  file: File,
): Promise<{ bytes: Uint8Array; contentType: AttachmentType } | { error: string }> {
  if (file.size > MAX_ATTACHMENT_BYTES) return { error: `${file.name || "Image"} is larger than 5 MB.` };
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > MAX_ATTACHMENT_BYTES) return { error: `${file.name || "Image"} is larger than 5 MB.` };
  const contentType = detectImageType(bytes);
  if (contentType === undefined) {
    return { error: `${file.name || "This file"} is not a PNG, JPEG, WebP or GIF image.` };
  }
  return { bytes, contentType };
}

function markdownFor(name: string, path: string): string {
  const alt = name.replace(/\.[A-Za-z0-9]{1,5}$/, "").replace(/[[\]\\\r\n]/g, " ").trim() || "image";
  return `![${alt}](${path})`;
}

function isAttachment(edit: Edit): edit is AttachmentEdit {
  return edit.kind === "addAttachment";
}

/**
 * Images pasted, dropped or picked in one editor. They stay pending (bytes in
 * IndexedDB, object URLs for the preview) until the caller turns them into
 * basket edits with `editsFor`, or drops them with `discard`.
 * `id` is the initiative the text belongs to; omit it for a new initiative.
 */
export function useImageAttachments({ repoId, id }: { repoId: string; id?: string }) {
  const basket = useBasket(repoId);
  const [pending, setPending] = useState<PendingImage[]>([]);
  const [urls, setUrls] = useState<ReadonlyMap<string, string>>(new Map());
  const pendingRef = useRef<PendingImage[]>([]);
  pendingRef.current = pending;
  const urlsRef = useRef(urls);
  urlsRef.current = urls;

  // Images already in the basket for this initiative preview from IndexedDB too.
  const queued = useMemo(
    () => basket.edits.filter(isAttachment).filter((edit) => id !== undefined && edit.id === id),
    [basket.edits, id],
  );
  useEffect(() => {
    let cancelled = false;
    const created: string[] = [];
    void (async () => {
      const next = new Map<string, string>();
      for (const edit of queued) {
        if (edit.key === undefined || urlsRef.current.has(edit.path)) continue;
        const stored = await getImage(edit.key).catch(() => undefined);
        if (stored === undefined || cancelled) continue;
        const url = objectUrl(stored.bytes, stored.contentType);
        if (url === undefined) continue;
        created.push(url);
        next.set(edit.path, url);
      }
      if (cancelled || next.size === 0) return;
      setUrls((current) => new Map([...current, ...next]));
    })();
    return () => {
      cancelled = true;
    };
  }, [queued]);

  useEffect(
    () => () => {
      for (const url of urlsRef.current.values()) revokeUrl(url);
    },
    [],
  );

  const attach = useCallback(
    async (files: readonly File[]): Promise<{ markdown: string; error?: string }> => {
      const lines: string[] = [];
      const inBasket = basket.list().filter(isAttachment);
      let count = inBasket.length + pendingRef.current.length;
      let total = [...inBasket, ...pendingRef.current].reduce((sum, entry) => sum + entry.size, 0);
      const taken = new Set([...queued.map((edit) => edit.path), ...pendingRef.current.map((entry) => entry.path)]);
      const added: PendingImage[] = [];
      const addedUrls = new Map<string, string>();
      let error: string | undefined;
      for (const file of files) {
        if (count >= MAX_ATTACHMENTS) {
          error = `At most ${MAX_ATTACHMENTS} images per basket.`;
          break;
        }
        const read = await readImageFile(file);
        if ("error" in read) {
          error = read.error;
          continue;
        }
        if (total + read.bytes.length > MAX_ATTACHMENT_TOTAL_BYTES) {
          error = `Images in one basket are limited to ${MAX_ATTACHMENT_TOTAL_BYTES / MB} MB.`;
          continue;
        }
        let path = uniqueAssetPath(file.name, read.contentType, taken);
        while (id !== undefined && (await committedAssetExists(repoId, id, path))) {
          taken.add(path);
          path = uniqueAssetPath(file.name, read.contentType, taken);
        }
        taken.add(path);
        const key = newImageKey();
        const image: PendingImage = {
          key,
          path,
          contentType: read.contentType,
          sha256: await sha256Hex(read.bytes),
          size: read.bytes.length,
          name: file.name,
        };
        try {
          await putImage(key, { bytes: read.bytes, contentType: read.contentType, name: file.name });
        } catch (caught) {
          error = caught instanceof Error ? caught.message : "Could not store the image.";
          continue;
        }
        const url = objectUrl(read.bytes, read.contentType);
        if (url !== undefined) addedUrls.set(path, url);
        added.push(image);
        lines.push(markdownFor(file.name, path));
        count += 1;
        total += image.size;
      }
      if (added.length > 0) {
        pendingRef.current = [...pendingRef.current, ...added];
        setPending(pendingRef.current);
        setUrls((current) => new Map([...current, ...addedUrls]));
      }
      return { markdown: lines.join("\n\n"), ...(error === undefined ? {} : { error }) };
    },
    [basket, id, queued, repoId],
  );

  const resolve = useCallback(
    (src: string) => resolveImageSrc(src, { repoId, ...(id === undefined ? {} : { id }), pending: urls }),
    [id, repoId, urls],
  );

  /** Basket edits for the pending images still referenced by `text`; unreferenced ones are dropped. */
  const editsFor = useCallback(
    (target: string, text: string): AttachmentEdit[] => {
      const kept: AttachmentEdit[] = [];
      for (const image of pendingRef.current) {
        if (!text.includes(`(${image.path})`)) {
          void deleteImage(image.key);
          continue;
        }
        kept.push({
          kind: "addAttachment",
          id: target,
          path: image.path,
          contentType: image.contentType,
          sha256: image.sha256,
          size: image.size,
          key: image.key,
        });
      }
      pendingRef.current = [];
      setPending([]);
      return kept;
    },
    [],
  );

  /** Forget pending images (cancel). Their bytes are deleted. */
  const discard = useCallback(() => {
    for (const image of pendingRef.current) void deleteImage(image.key);
    pendingRef.current = [];
    setPending([]);
  }, []);

  const images: EditorImages = useMemo(() => ({ attach, resolve }), [attach, resolve]);
  return { images, pending, editsFor, discard };
}

async function committedAssetExists(repoId: string, id: string, path: string): Promise<boolean> {
  try {
    const response = await fetch(assetUrl(repoId, id, path), { method: "HEAD", credentials: "same-origin" });
    return response.ok;
  } catch {
    return false;
  }
}

function objectUrl(bytes: Uint8Array, type: string): string | undefined {
  if (typeof URL.createObjectURL !== "function") return undefined;
  return URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type }));
}

function revokeUrl(url: string): void {
  if (typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
}
