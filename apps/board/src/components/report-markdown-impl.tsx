import MDEditor from "@uiw/react-md-editor/nohighlight";
import { useEffect, useMemo, useState, type AnchorHTMLAttributes, type ImgHTMLAttributes, type ReactNode } from "react";
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize";
import type { ReportMarkdownProps } from "./report-markdown";

// Same rules as the editor preview: raw HTML is skipped, the tree is sanitized, and every
// image src goes through `resolveImage` (relative paths inside the initiative folder only).
const SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  attributes: { ...defaultSchema.attributes, img: ["src", "alt", "title"] },
};

type AnchorProps = AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown; children?: ReactNode };
type ImageProps = ImgHTMLAttributes<HTMLImageElement> & { node?: unknown };

function ReportImage({ node: _node, src, alt, title }: ImageProps) {
  if (typeof src !== "string" || src.length === 0) {
    return (
      <span data-testid="blocked-image" className="text-muted-foreground">
        [{alt || "image"}: remote images are not loaded]
      </span>
    );
  }
  return <img src={src} alt={alt ?? ""} title={title} loading="lazy" referrerPolicy="no-referrer" />;
}

function useDocumentDark(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setDark(root.classList.contains("dark"));
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

export default function ReportMarkdownImpl({ markdown, resolveImage, renderLink }: ReportMarkdownProps) {
  const dark = useDocumentDark();
  const components = useMemo(
    () => ({
      img: ReportImage,
      a: ({ node: _node, href, children }: AnchorProps) => renderLink(href ?? "", children),
    }),
    [renderLink],
  );
  return (
    <div
      data-color-mode={dark ? "dark" : "light"}
      data-testid="report-markdown"
      className="[&_ol]:list-decimal [&_ul]:list-disc [&_ul_ul]:list-[circle]"
    >
      <MDEditor.Markdown
        source={markdown}
        skipHtml
        // Links keep their raw value here; `renderLink` decides what each one may do.
        urlTransform={(url: string, key: string) => (key === "src" ? resolveImage(url) : url)}
        rehypePlugins={[[rehypeSanitize, SCHEMA]] as never}
        components={components as never}
        style={{ background: "transparent" }}
      />
    </div>
  );
}
