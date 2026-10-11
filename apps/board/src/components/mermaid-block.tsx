import { Check, Copy, Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useState, type HTMLAttributes, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

type HastNode = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
};

function hastText(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(hastText).join("");
}

/** Source of a fenced ```mermaid block, or null when the `<pre>` node is any other code. */
export function mermaidSource(node: unknown): string | null {
  const pre = node as HastNode | undefined;
  if (pre?.tagName !== "pre") return null;
  const code = pre.children?.find((child) => child.type === "element" && child.tagName === "code");
  const classes = code?.properties?.className;
  if (code === undefined || !Array.isArray(classes) || !classes.includes("language-mermaid")) return null;
  return hastText(code).replace(/\n$/, "");
}

/** Tracks the `dark` class on <html>; false during SSR and the first client render. */
export function useDocumentDark(): boolean {
  const [dark, setDark] = useState(false);
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

type DiagramState = { phase: "source" } | { phase: "svg"; svg: string } | { phase: "error"; message: string };

function SourceBlock({ source }: { source: string }) {
  return (
    <pre data-testid="mermaid-source">
      <code className="language-mermaid">{source}</code>
    </pre>
  );
}

const ZOOMS = [0.5, 0.75, 1, 1.5, 2, 3];

// The server never renders diagrams; leaving the import out of the SSR build keeps mermaid
// and its dependencies out of the server bundle and the runtime image.
const loadRenderer = import.meta.env.SSR ? null : () => import("./mermaid-render");

/**
 * Renders a mermaid diagram. On the server and until mermaid has loaded it shows the
 * source as a plain code block; mermaid itself is imported only once this mounts.
 */
export function MermaidBlock({ source }: { source: string }) {
  const dark = useDocumentDark();
  const [state, setState] = useState<DiagramState>({ phase: "source" });
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const [zoom, setZoom] = useState(2);

  useEffect(() => {
    if (loadRenderer === null) return;
    let active = true;
    loadRenderer()
      .then(({ renderMermaid }) => renderMermaid(source, dark))
      .then(
        (svg) => {
          if (active) setState(svg.length > 0 ? { phase: "svg", svg } : { phase: "error", message: "empty diagram" });
        },
        (error: unknown) => {
          if (active) setState({ phase: "error", message: error instanceof Error ? error.message : String(error) });
        },
      );
    return () => {
      active = false;
    };
  }, [source, dark]);

  if (state.phase !== "svg") {
    return (
      <div data-testid="mermaid-block" data-state={state.phase} className="not-prose">
        <SourceBlock source={source} />
        {state.phase === "error" ? (
          <p data-testid="mermaid-error" role="note" className="mt-1 text-xs text-destructive">
            diagram error: {state.message.split("\n")[0]}
          </p>
        ) : null}
      </div>
    );
  }

  const copy = () => {
    void navigator.clipboard?.writeText(source).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <figure data-testid="mermaid-block" data-state="svg" className="group/mermaid relative my-3">
      <div className="absolute top-1 right-1 flex gap-1 opacity-70 transition-opacity group-hover/mermaid:opacity-100">
        <Button type="button" variant="outline" size="icon-xs" aria-label="Copy diagram source" title="Copy source" onClick={copy}>
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon-xs"
          aria-label="View diagram larger"
          title="View larger"
          onClick={() => setOpen(true)}
        >
          <Maximize2 aria-hidden="true" />
        </Button>
      </div>
      <DiagramSvg svg={state.svg} testId="mermaid-diagram" className="flex justify-center overflow-x-auto [&_svg]:h-auto [&_svg]:max-w-full" />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex h-[calc(100dvh-2rem)] flex-col sm:max-w-[calc(100vw-2rem)]">
          <div className="flex items-center gap-2 pr-8">
            <DialogTitle>Diagram</DialogTitle>
            <span className="ml-auto text-xs text-muted-foreground">{Math.round((ZOOMS[zoom] ?? 1) * 100)}%</span>
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              aria-label="Zoom out"
              disabled={zoom === 0}
              onClick={() => setZoom((value) => Math.max(0, value - 1))}
            >
              <ZoomOut aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              aria-label="Zoom in"
              disabled={zoom === ZOOMS.length - 1}
              onClick={() => setZoom((value) => Math.min(ZOOMS.length - 1, value + 1))}
            >
              <ZoomIn aria-hidden="true" />
            </Button>
            <Button type="button" variant="outline" size="icon-xs" aria-label="Copy diagram source" onClick={copy}>
              {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto rounded-md border bg-background p-2">
            <DiagramSvg
              svg={state.svg}
              testId="mermaid-diagram-large"
              style={{ width: `${(ZOOMS[zoom] ?? 1) * 100}%` }}
              className="mx-auto [&_svg]:h-auto [&_svg]:w-full [&_svg]:max-w-none!"
            />
          </div>
        </DialogContent>
      </Dialog>
    </figure>
  );
}

function DiagramSvg({ svg, testId, ...props }: { svg: string; testId: string } & HTMLAttributes<HTMLDivElement>) {
  // `svg` comes from mermaid strict mode and then `hardenSvg`; user HTML never reaches here.
  return <div {...props} data-testid={testId} dangerouslySetInnerHTML={{ __html: svg }} />;
}

type PreProps = HTMLAttributes<HTMLPreElement> & { node?: unknown; children?: ReactNode };

/** `pre` override for react-markdown: mermaid fences become diagrams, other code is untouched. */
export function MarkdownPre({ node, children, ...props }: PreProps) {
  const source = mermaidSource(node);
  if (source !== null) return <MermaidBlock source={source} />;
  return <pre {...props}>{children}</pre>;
}
