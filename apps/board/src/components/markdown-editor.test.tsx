// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownEditor } from "@/components/markdown-editor";
import { safeUrl } from "@/components/markdown-editor-impl";
import { resolveImageSrc } from "@/features/attachments/images";

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark");
});

function Harness({ initial, onChange }: { initial: string; onChange: (value: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <MarkdownEditor
      aria-label="Initiative text"
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

describe("MarkdownEditor", () => {
  it("renders a plain textarea on the server", () => {
    const html = renderToString(<MarkdownEditor aria-label="Initiative text" value="# Hi" onChange={() => {}} />);
    expect(html).toContain("<textarea");
    expect(html).toContain('aria-label="Initiative text"');
    expect(html).toContain("# Hi");
    expect(html).not.toContain("w-md-editor");
  });

  it("loads the editor in the browser, follows dark mode, and reports exactly what is typed", async () => {
    document.documentElement.classList.add("dark");
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial="" onChange={onChange} />);
    const wrapper = await screen.findByTestId("markdown-editor", {}, { timeout: 10_000 });
    expect(wrapper.getAttribute("data-color-mode")).toBe("dark");
    const textarea = await waitFor(() => {
      const found = wrapper.querySelector("textarea");
      if (found === null) throw new Error("no textarea");
      return found;
    });
    expect(textarea.getAttribute("aria-label")).toBe("Initiative text");
    expect(wrapper.querySelector(".w-md-editor-toolbar")).not.toBeNull();
    await user.type(textarea, "a  *b*");
    expect(onChange).toHaveBeenLastCalledWith("a  *b*");
  });

  it("does not render raw HTML, images, or script links in the preview", async () => {
    const source = [
      "<script>window.__pwned = 1</script>",
      '<img src="https://example.com/x.png" onerror="window.__pwned = 1">',
      "![remote](https://example.com/y.png)",
      "[bad](javascript:alert(1)) [good](https://example.com/)",
    ].join(String.fromCharCode(10, 10));
    render(<Harness initial={source} onChange={() => {}} />);
    const wrapper = await screen.findByTestId("markdown-editor", {}, { timeout: 10_000 });
    const preview = await waitFor(() => {
      const found = wrapper.querySelector(".wmde-markdown");
      if (found === null || !found.textContent?.includes("good")) throw new Error("no preview");
      return found;
    });
    expect(preview.querySelector("script")).toBeNull();
    expect(preview.querySelector("img")).toBeNull();
    expect(preview.querySelector("[onerror]")).toBeNull();
    const hrefs = [...preview.querySelectorAll("a")].map((anchor) => anchor.getAttribute("href") ?? "");
    expect(hrefs.some((href) => href.toLowerCase().startsWith("javascript:"))).toBe(false);
    expect(hrefs).toContain("https://example.com/");
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("with images, previews assets/ through the endpoint and still blocks remote images", async () => {
    const source = ["![ok](assets/flow.png)", "![remote](https://example.com/y.png)"].join(String.fromCharCode(10, 10));
    render(
      <MarkdownEditor
        aria-label="Initiative text"
        value={source}
        onChange={() => {}}
        images={{
          attach: async () => ({ markdown: "" }),
          resolve: (src) => resolveImageSrc(src, { repoId: "acme", id: "acme-002" }),
        }}
      />,
    );
    const wrapper = await screen.findByTestId("markdown-editor", {}, { timeout: 10_000 });
    const preview = await waitFor(() => {
      const found = wrapper.querySelector(".wmde-markdown");
      if (found === null || found.querySelector("img") === null) throw new Error("no preview");
      return found;
    });
    expect([...preview.querySelectorAll("img")].map((img) => img.getAttribute("src"))).toEqual([
      "/api/repos/acme/initiatives/acme-002/assets/flow.png",
    ]);
    expect(preview.querySelector("[data-testid=blocked-image]")?.textContent).toContain("remote");
  });

  it("only allows safe URLs", () => {
    expect(safeUrl("javascript:alert(1)")).toBe("");
    expect(safeUrl("//evil.example")).toBe("");
    expect(safeUrl("data:text/html,x")).toBe("");
    expect(safeUrl("https://example.com")).toBe("https://example.com");
    expect(safeUrl("#top")).toBe("#top");
    expect(safeUrl("../x.md")).toBe("../x.md");
  });
});
