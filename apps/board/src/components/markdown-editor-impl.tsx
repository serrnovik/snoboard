import MDEditor, { commands, type ICommand } from "@uiw/react-md-editor/nohighlight";
import { ImagePlus } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type ImgHTMLAttributes,
} from "react";
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize";
import type { EditorImages } from "@/features/attachments/images";
import type { MarkdownEditorProps } from "./markdown-editor";

// Preview never renders raw HTML (skipHtml) and is sanitized after the editor's
// own rehype plugins. Without `images`, <img> is dropped so the preview makes no
// network loads. With `images`, <img> is kept and its src goes through
// `images.resolve`, which only allows relative `assets/...` paths.
const NO_IMAGES_SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames ?? []).filter((tag) => tag !== "img"),
};
const IMAGES_SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  attributes: { ...defaultSchema.attributes, img: ["src", "alt", "title"] },
};

// Keep the toolbar offline: no "help" link to the package's website, and no
// built-in image command (it inserts remote URLs); "Attach image" replaces it.
const BASE_TOOLBAR = commands.getCommands().filter((command) => command.name !== "help" && command.name !== "image");
const EXTRA = commands.getExtraCommands();
const ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

export function safeUrl(url: string): string {
  const trimmed = url.trim();
  if (/^(?:#|\/(?!\/)|\.\.?\/)/.test(trimmed)) return trimmed;
  if (/^https?:\/\//i.test(trimmed) || /^mailto:/i.test(trimmed)) return trimmed;
  return "";
}

function useDocumentDark(): boolean {
  // Client-only module, so reading the document during the first render is safe.
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setDark(root.classList.contains("dark"));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

function imageFiles(list: FileList | null | undefined): File[] {
  if (list === null || list === undefined) return [];
  return [...list].filter((file) => file.type.startsWith("image/") || file.type === "");
}

type PreviewImageProps = ImgHTMLAttributes<HTMLImageElement> & { node?: unknown };

function PreviewImage({ node: _node, src, alt, title }: PreviewImageProps) {
  if (typeof src !== "string" || src.length === 0) {
    return (
      <span data-testid="blocked-image" className="text-muted-foreground">
        [{alt || "image"}: only attached images are shown]
      </span>
    );
  }
  return <img src={src} alt={alt ?? ""} title={title} loading="lazy" referrerPolicy="no-referrer" />;
}

export default function MarkdownEditorImpl({
  value,
  onChange,
  minHeight = 240,
  "aria-label": ariaLabel,
  images,
}: MarkdownEditorProps) {
  const dark = useDocumentDark();
  const wrapper = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const latest = useRef(value);
  latest.current = value;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function attach(files: File[], images: EditorImages) {
    if (files.length === 0) return;
    const textarea = wrapper.current?.querySelector("textarea");
    const at = textarea?.selectionEnd ?? latest.current.length;
    setBusy(true);
    try {
      const result = await images.attach(files);
      setError(result.error ?? null);
      if (result.markdown.length === 0) return;
      const text = latest.current;
      const position = Math.min(Math.max(at, 0), text.length);
      const before = text.slice(0, position);
      const after = text.slice(position);
      const lead = before.length === 0 || before.endsWith("\n") ? "" : "\n";
      onChange(`${before}${lead}${result.markdown}\n${after}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not attach the image.");
    } finally {
      setBusy(false);
    }
  }

  const toolbar = useMemo((): ICommand[] => {
    if (images === undefined) return BASE_TOOLBAR;
    const attachCommand: ICommand = {
      name: "attach-image",
      keyCommand: "attach-image",
      buttonProps: { "aria-label": "Attach image", title: "Attach image" },
      icon: <ImagePlus aria-hidden="true" className="size-3" />,
      execute: () => picker.current?.click(),
    };
    return [...BASE_TOOLBAR, commands.divider, attachCommand];
  }, [images]);

  const previewOptions = useMemo(
    () => ({
      skipHtml: true,
      urlTransform: (url: string, key: string) => {
        if (key === "src") return images === undefined ? "" : images.resolve(url);
        return safeUrl(url);
      },
      rehypePlugins: [[rehypeSanitize, images === undefined ? NO_IMAGES_SCHEMA : IMAGES_SCHEMA]] as never,
      components: { img: PreviewImage },
    }),
    [images],
  );

  return (
    <div
      ref={wrapper}
      data-color-mode={dark ? "dark" : "light"}
      data-testid="markdown-editor"
      onPasteCapture={(event: ClipboardEvent<HTMLDivElement>) => {
        if (images === undefined) return;
        const files = imageFiles(event.clipboardData?.files);
        if (files.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        void attach(files, images);
      }}
      onDragOverCapture={(event: DragEvent<HTMLDivElement>) => {
        if (images !== undefined && [...(event.dataTransfer?.types ?? [])].includes("Files")) event.preventDefault();
      }}
      onDropCapture={(event: DragEvent<HTMLDivElement>) => {
        if (images === undefined) return;
        const files = imageFiles(event.dataTransfer?.files);
        if (files.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        void attach(files, images);
      }}
    >
      <MDEditor
        value={value}
        onChange={(next) => onChange(next ?? "")}
        height={minHeight}
        minHeight={minHeight}
        preview="live"
        commands={toolbar}
        extraCommands={EXTRA}
        textareaProps={{ "aria-label": ariaLabel }}
        previewOptions={previewOptions}
      />
      {images !== undefined ? (
        <input
          ref={picker}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          data-testid="attach-image-input"
          aria-label="Attach image file"
          onChange={(event) => {
            const files = imageFiles(event.target.files);
            event.target.value = "";
            void attach(files, images);
          }}
        />
      ) : null}
      {busy ? <p className="text-xs text-muted-foreground">Attaching image…</p> : null}
      {error !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
