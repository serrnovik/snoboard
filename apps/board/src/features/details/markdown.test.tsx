// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SummaryMarkdown } from "./markdown.js";

afterEach(() => {
  cleanup();
});

describe("summary markdown", () => {
  it("strips a script tag and marks external links as noreferrer", () => {
    const { container } = render(
      <SummaryMarkdown
        markdown={"Before <script>alert(1)</script> after\n\n[Docs](https://example.com/docs)"}
      />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.innerHTML.toLowerCase()).not.toContain("<script");
    expect(container.textContent).not.toContain("alert(1)");
    expect(container.textContent).toContain("Before");
    expect(container.textContent).toContain("after");
    const link = screen.getByRole("link", { name: "Docs" });
    expect(link.getAttribute("href")).toBe("https://example.com/docs");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("drops javascript URLs and leaves relative links without noreferrer", () => {
    const { rerender } = render(<SummaryMarkdown markdown={"[bad](javascript:alert(1))"} />);
    const bad = screen.getByText("bad").closest("a");
    expect(bad?.getAttribute("href") ?? "").not.toMatch(/^javascript:/i);

    rerender(<SummaryMarkdown markdown={"[board](/graph)"} />);
    const board = screen.getByRole("link", { name: "board" });
    expect(board.getAttribute("href")).toBe("/graph");
    expect(board.getAttribute("rel")).toBeNull();
  });
});
