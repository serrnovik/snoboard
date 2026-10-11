// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownEditor } from "@/components/markdown-editor";
import { ReportMarkdown } from "@/components/report-markdown";
import { SummaryMarkdown } from "@/features/details/markdown";
import { hardenSvg, mermaidConfig } from "./mermaid-render";

const mock = vi.hoisted(() => ({
  loaded: vi.fn(),
  initialize: vi.fn(),
  render: vi.fn(async (id: string, text: string) => {
    if (text.includes("broken")) throw new Error("Parse error on line 2:\nExpecting something");
    return {
      svg: `<svg id="${id}" xmlns="http://www.w3.org/2000/svg"><g onclick="window.__pwned=1"><a href="javascript:alert(1)"><text>${text.length}</text></a></g><script>window.__pwned=1</script></svg>`,
    };
  }),
}));

vi.mock("mermaid", () => {
  mock.loaded();
  return { default: { initialize: mock.initialize, render: mock.render } };
});

const NL = String.fromCharCode(10);
const FLOW = ["```mermaid", "flowchart LR", "  A --> B", "```"].join(NL);
const CODE = ["```ts", "const answer = 42;", "```"].join(NL);

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark");
});

describe("mermaid in markdown", () => {
  // Runs first: nothing in this file has imported mermaid yet.
  it("leaves other code blocks unchanged and never loads mermaid without a mermaid block", async () => {
    const { container } = render(<SummaryMarkdown markdown={`Intro${NL}${NL}${CODE}`} />);
    const code = container.querySelector("pre > code.language-ts");
    expect(code?.textContent).toContain("const answer = 42;");
    expect(screen.queryByTestId("mermaid-block")).toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(mock.loaded).not.toHaveBeenCalled();
    expect(mock.render).not.toHaveBeenCalled();
  });

  it("renders the source as a plain code block on the server", () => {
    const html = renderToString(<SummaryMarkdown markdown={FLOW} />);
    expect(html).toContain("<pre");
    expect(html).toContain("flowchart LR");
    expect(html).toContain('data-state="source"');
    expect(html).not.toContain("<svg");
    expect(mock.loaded).not.toHaveBeenCalled();
  });

  it("turns a mermaid block into a hardened diagram in strict mode", async () => {
    render(<SummaryMarkdown markdown={FLOW} />);
    const diagram = await screen.findByTestId("mermaid-diagram");
    expect(mock.loaded).toHaveBeenCalledTimes(1);
    expect(mock.render).toHaveBeenCalledWith(expect.stringMatching(/^snoboard-mermaid-/), "flowchart LR\n  A --> B");
    expect(mock.initialize).toHaveBeenLastCalledWith(
      expect.objectContaining({ startOnLoad: false, securityLevel: "strict", htmlLabels: false, theme: "default" }),
    );
    expect(diagram.querySelector("svg")).not.toBeNull();
    expect(diagram.querySelector("script")).toBeNull();
    expect(diagram.querySelector("[onclick]")).toBeNull();
    expect(diagram.querySelector("a")?.getAttribute("href")).toBeNull();
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
    expect(screen.getByRole("button", { name: "Copy diagram source" })).toBeTruthy();
  });

  it("shows the source with a short error note when mermaid cannot parse it", async () => {
    render(<SummaryMarkdown markdown={["```mermaid", "flowchart broken", "```"].join(NL)} />);
    const note = await screen.findByTestId("mermaid-error");
    expect(note.textContent).toBe("diagram error: Parse error on line 2:");
    expect(screen.getByTestId("mermaid-source").textContent).toContain("flowchart broken");
    expect(screen.queryByTestId("mermaid-diagram")).toBeNull();
  });

  it("renders in the document viewer, re-renders on theme change, and opens a larger view", async () => {
    render(<ReportMarkdown markdown={`# Plan${NL}${NL}${FLOW}`} resolveImage={() => ""} renderLink={(_href, children) => children} />);
    await screen.findByTestId("mermaid-diagram", {}, { timeout: 10_000 });
    mock.initialize.mockClear();
    act(() => document.documentElement.classList.add("dark"));
    await waitFor(() => expect(mock.initialize).toHaveBeenCalledWith(expect.objectContaining({ theme: "dark" })));

    fireEvent.click(screen.getByRole("button", { name: "View diagram larger" }));
    const large = await screen.findByTestId("mermaid-diagram-large");
    expect(large.querySelector("svg")).not.toBeNull();
    expect(large.style.width).toBe("100%");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(large.style.width).toBe("150%");
  });

  it("renders in the editor preview", async () => {
    render(<MarkdownEditor aria-label="Initiative text" value={FLOW} onChange={() => {}} />);
    const wrapper = await screen.findByTestId("markdown-editor", {}, { timeout: 10_000 });
    await waitFor(() => {
      if (wrapper.querySelector("[data-testid=mermaid-diagram] svg") === null) throw new Error("no diagram");
    });
  });

  it("copies the diagram source", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<SummaryMarkdown markdown={FLOW} />);
    await screen.findByTestId("mermaid-diagram");
    fireEvent.click(screen.getByRole("button", { name: "Copy diagram source" }));
    expect(writeText).toHaveBeenCalledWith("flowchart LR\n  A --> B");
  });
});

describe("mermaid hardening", () => {
  it("keeps strict settings out of reach of diagram directives", () => {
    const config = mermaidConfig(true);
    expect(config.securityLevel).toBe("strict");
    expect(config.theme).toBe("dark");
    expect(config.secure).toEqual(expect.arrayContaining(["securityLevel", "htmlLabels", "themeCSS", "theme"]));
  });

  it("drops scripts, handlers, remote links, media and remote CSS but keeps fragment references", () => {
    const svg = hardenSvg(
      [
        '<svg xmlns="http://www.w3.org/2000/svg">',
        "<style>@import url(https://example.com/x.css); .a{fill:url(#grad)} .b{background:url(https://example.com/p.png)}</style>",
        '<a href="https://example.com"><text onmouseover="x()">t</text></a>',
        '<use href="#marker"/><image href="https://example.com/i.png"/><foreignObject><img src="https://example.com/y.png"></foreignObject>',
        "<script>alert(1)</script></svg>",
      ].join(""),
    );
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("onmouseover");
    expect(svg).not.toContain("example.com");
    expect(svg).not.toContain("<img");
    expect(svg).toContain('href="#marker"');
    expect(svg).toContain("url(#grad)");
  });
});
