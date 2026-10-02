import { lazy, Suspense, useEffect, useState } from "react";
import type { EditorImages } from "@/features/attachments/images";

export type MarkdownEditorProps = {
  value: string;
  onChange: (value: string) => void;
  /** Editor height in pixels. */
  minHeight?: number;
  "aria-label": string;
  /** Paste, drop or pick images, and preview `assets/...` images. Without it images are blocked. */
  images?: EditorImages;
};

// The editor and its CSS live in their own chunk. It is loaded only in the
// browser, after hydration, so SSR and the main bundle never include it.
const LazyEditor = lazy(() => import("./markdown-editor-impl"));

const FALLBACK_CLASS =
  "w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** Plain textarea with the same contract; shown during SSR and while the editor loads. */
export function MarkdownTextarea({
  value,
  onChange,
  minHeight = 240,
  "aria-label": ariaLabel,
}: MarkdownEditorProps) {
  return (
    <textarea
      aria-label={ariaLabel}
      data-testid="markdown-editor-fallback"
      className={FALLBACK_CLASS}
      style={{ minHeight }}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/** Markdown editor with toolbar and live preview. onChange receives exactly what was typed. */
export function MarkdownEditor(props: MarkdownEditorProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <MarkdownTextarea {...props} />;
  return (
    <Suspense fallback={<MarkdownTextarea {...props} />}>
      <LazyEditor {...props} />
    </Suspense>
  );
}
