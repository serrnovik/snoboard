import type { AnchorHTMLAttributes, ImgHTMLAttributes, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";

type MarkdownAnchorProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  node?: unknown;
  children?: ReactNode;
};

function stripRawHtml(markdown: string): string {
  return markdown
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<\/?[A-Za-z][^>\n]*>/g, "");
}

function safeUrl(url: string): string {
  const trimmed = url.trim();
  if (
    trimmed.startsWith("#") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../")
  ) {
    return trimmed;
  }
  if (/^https?:\/\//i.test(trimmed) || /^mailto:/i.test(trimmed)) return trimmed;
  return "";
}

function MarkdownLink({ node: _node, href, children, ...props }: MarkdownAnchorProps) {
  const external = href !== undefined && /^https?:\/\//i.test(href);
  return (
    <a
      {...props}
      href={href}
      rel={external ? "noopener noreferrer" : undefined}
      target={external ? "_blank" : undefined}
    >
      {children}
    </a>
  );
}

type MarkdownImageProps = ImgHTMLAttributes<HTMLImageElement> & { node?: unknown };

function MarkdownImage({ node: _node, src, alt, title }: MarkdownImageProps) {
  if (typeof src !== "string" || src.length === 0) {
    return <span className="text-muted-foreground">[{alt || "image"}]</span>;
  }
  return <img src={src} alt={alt ?? ""} title={title} loading="lazy" referrerPolicy="no-referrer" className="max-w-full" />;
}

/**
 * Renders initiative markdown. Images show only when `resolveImage` maps their
 * src (relative `assets/...` paths) to a URL; remote images are always blocked.
 */
export function SummaryMarkdown({
  markdown,
  resolveImage,
}: {
  markdown: string;
  resolveImage?: (src: string) => string;
}) {
  const source = stripRawHtml(markdown).trim();
  if (source.length === 0) {
    return <p className="text-sm text-muted-foreground">No summary.</p>;
  }
  return (
    <div className="space-y-2 text-sm leading-6 [&_a]:underline [&_ol]:list-decimal [&_ol]:pl-5 [&_p+p]:mt-2 [&_ul]:list-disc [&_ul]:pl-5">
      <ReactMarkdown
        rehypePlugins={[rehypeSanitize]}
        urlTransform={(url, key) => (key === "src" ? (resolveImage?.(url) ?? "") : safeUrl(url))}
        components={{ a: MarkdownLink, img: MarkdownImage }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
