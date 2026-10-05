// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { IssueBadge, IssueCount, type IssueView } from "@/features/issues/IssueBadge";

function issue(overrides: Partial<IssueView> & Pick<IssueView, "raw" | "state">): IssueView {
  return {
    url: "",
    title: "",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("issue badge", () => {
  it("colors an open issue and links out", () => {
    render(
      <IssueBadge
        issue={issue({
          raw: "gh#12",
          title: "Export",
          state: "open",
          url: "https://github.com/acme/widgets/issues/12",
        })}
      />,
    );
    const link = screen.getByTestId("issue-link");
    expect(link.getAttribute("href")).toBe("https://github.com/acme/widgets/issues/12");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("data-state")).toBe("open");
    expect(link.getAttribute("data-provider")).toBe("gh");
    expect(link.className).toContain("text-emerald-800");
    expect(link.textContent).toContain("gh#12");
    expect(link.textContent).toContain("Export");
    expect(link.textContent).toContain("open");
    expect(link.querySelector("svg")).toBeTruthy();
  });

  it("links a Forgejo ref with its own icon", () => {
    render(
      <>
        <IssueBadge issue={issue({ raw: "fj#12", state: "unknown", url: "https://forge.example.com/acme/widgets/issues/12" })} />
        <IssueBadge issue={issue({ raw: "gh#12", state: "unknown", url: "https://github.com/acme/widgets/issues/12" })} />
      </>,
    );
    const [forgejo, github] = screen.getAllByTestId("issue-link");
    expect(forgejo?.getAttribute("href")).toBe("https://forge.example.com/acme/widgets/issues/12");
    expect(forgejo?.getAttribute("target")).toBe("_blank");
    expect(forgejo?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(forgejo?.getAttribute("data-provider")).toBe("fj");
    const icon = (element: Element | undefined) => element?.querySelector("svg")?.getAttribute("class") ?? "";
    expect(icon(forgejo)).toContain("git-branch");
    expect(icon(forgejo)).not.toBe(icon(github));
  });

  it("colors a closed issue differently from an open one", () => {
    render(
      <IssueBadge
        issue={issue({
          raw: "vikunja:34",
          title: "Invoice",
          state: "closed",
          url: "https://tasks.example.com/tasks/34",
        })}
      />,
    );
    const link = screen.getByTestId("issue-link");
    expect(link.getAttribute("data-provider")).toBe("vikunja");
    expect(link.className).toContain("text-muted-foreground");
    expect(link.className).not.toContain("text-emerald-800");
    expect(link.textContent).toContain("closed");
  });

  it("renders an unknown state as a plain link", () => {
    render(
      <IssueBadge
        issue={issue({
          raw: "linear:ABC-1",
          state: "unknown",
          url: "https://example.com/ABC-1",
        })}
      />,
    );
    const link = screen.getByTestId("issue-link");
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("https://example.com/ABC-1");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("data-state")).toBe("unknown");
    expect(link.className).not.toContain("destructive");
    expect(link.className).not.toContain("text-emerald-800");
    expect(link.textContent).toContain("linear:ABC-1");
    expect(link.textContent).not.toContain("unknown");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders a ref without a url as text", () => {
    render(<IssueBadge issue={issue({ raw: "gh#12", state: "unknown" })} />);
    expect(screen.queryByTestId("issue-link")).toBeNull();
    const ref = screen.getByTestId("issue-ref");
    expect(ref.tagName).toBe("SPAN");
    expect(ref.textContent).toContain("gh#12");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("counts only the issues the details sheet shows", () => {
    const { rerender } = render(<IssueCount issues={["", "  ", "gh#12"]} />);
    expect(screen.getByTestId("issue-count").getAttribute("aria-label")).toBe("1 issue");
    rerender(<IssueCount issues={[""]} />);
    expect(screen.queryByTestId("issue-count")).toBeNull();
  });
});
