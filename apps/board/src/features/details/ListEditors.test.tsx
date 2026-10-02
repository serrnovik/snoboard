// @vitest-environment jsdom

import { cleanup, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { resetBasketStore, useBasket } from "@/features/basket/store";
import { issueRefInput, issueRefProblem, IssuesEditor, LinksEditor } from "@/features/details/ListEditors";

afterEach(() => {
  cleanup();
  localStorage.clear();
  resetBasketStore();
});

describe("issues editor", () => {
  it("shows refs as chips with their state, adds and removes refs through the basket", async () => {
    const user = userEvent.setup();
    const basket = renderHook(() => useBasket());
    render(
      <IssuesEditor
        id="acme-002"
        issues={[
          { raw: "gh#12", url: "https://github.com/acme/board/issues/12", title: "Fix login", state: "open" },
          { raw: "vikunja:45", url: "", title: "", state: "unknown" },
        ]}
      />,
    );
    const chips = screen.getAllByTestId("issue-chip");
    expect(chips).toHaveLength(2);
    expect(chips[0]?.querySelector("[data-state='open']")?.textContent).toContain("Fix login");

    const input = screen.getByRole("textbox", { name: "Add issue ref" });
    await user.type(input, "gh#");
    expect(screen.getByRole("alert").textContent).toContain("gh#12");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect((screen.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(input, "7{Enter}");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(basket.result.current.list()).toEqual([
      { kind: "setIssues", id: "acme-002", from: ["gh#12", "vikunja:45"], to: ["gh#12", "vikunja:45", "gh#7"] },
    ]);
    expect(screen.getAllByTestId("issue-chip")).toHaveLength(3);

    await user.click(screen.getByRole("button", { name: "Remove gh#12" }));
    expect(basket.result.current.list()).toEqual([
      { kind: "setIssues", id: "acme-002", from: ["gh#12", "vikunja:45"], to: ["vikunja:45", "gh#7"] },
    ]);
    await user.type(input, "vikunja:45");
    expect(screen.getByRole("alert").textContent).toContain("already listed");
  });

  it("checks syntax and the 30-ref limit", () => {
    expect(issueRefProblem("", [])).toBeUndefined();
    expect(issueRefProblem("gh:owner/name#3", [])).toBeUndefined();
    expect(issueRefProblem("gh#abc", [])).toMatch(/Use gh#12/);
    const full = Array.from({ length: 30 }, (_, index) => `gh#${index + 1}`);
    expect(issueRefProblem("gh#99", full)).toMatch(/At most 30/);
  });

  it("treats vj: and vikunja: as the same task", () => {
    expect(issueRefProblem("vj:45", ["vikunja:45"])).toMatch(/vj:45 is already listed/);
    expect(issueRefInput("vikunja:45")).toEqual({ ref: "vj:45" });
  });

  it("turns pasted URLs into short refs and rejects other hosts", () => {
    const config = { vikunjaBaseUrl: "https://tasks.example.com", githubRepo: "acme/board" };
    expect(issueRefInput("https://tasks.example.com/tasks/45", config)).toEqual({ ref: "vj:45" });
    expect(issueRefInput("https://github.com/acme/board/pull/3", config)).toEqual({ ref: "gh#3" });
    expect(issueRefInput("https://github.com/other/repo/issues/8", config)).toEqual({ ref: "gh:other/repo#8" });
    expect(issueRefProblem("https://evil.example.org/tasks/45", [], config)).toMatch(/is not this repository's/);
  });

  it("adds a pasted URL as its short form and links chips without a fetched state", async () => {
    const user = userEvent.setup();
    const basket = renderHook(() => useBasket());
    render(
      <IssuesEditor
        id="acme-002"
        issues={[{ raw: "vikunja:45", url: "", title: "", state: "unknown" }]}
        linkConfig={{ vikunjaBaseUrl: "https://tasks.example.com", githubRepo: "acme/board" }}
      />,
    );
    const input = screen.getByRole("textbox", { name: "Add issue ref" });
    await user.click(input);
    await user.paste("https://github.com/acme/board/issues/12");
    await user.keyboard("{Enter}");
    expect(basket.result.current.list()).toEqual([
      { kind: "setIssues", id: "acme-002", from: ["vikunja:45"], to: ["vikunja:45", "gh#12"] },
    ]);
    const links = screen.getAllByTestId("issue-link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "https://tasks.example.com/tasks/45",
      "https://github.com/acme/board/issues/12",
    ]);
    for (const link of links) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    }
    await user.click(input);
    await user.paste("https://other.example.org/tasks/9");
    expect(screen.getByRole("alert").textContent).toContain("other.example.org is not this repository's");
  });
});

describe("links editor", () => {
  it("adds, edits, validates and removes link rows", async () => {
    const user = userEvent.setup();
    const basket = renderHook(() => useBasket());
    render(<LinksEditor id="acme-002" links={[{ title: "Spec", url: "https://example.com/spec" }]} />);
    expect(screen.getAllByTestId("link-row")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Add link" }));
    await user.type(screen.getByRole("textbox", { name: "Link 2 title" }), "Bad");
    await user.type(screen.getByRole("textbox", { name: "Link 2 URL" }), "javascript:alert(1)");
    await user.click(screen.getByRole("button", { name: "Save links" }));
    expect(screen.getByRole("alert").textContent).toContain("https: or mailto:");
    expect(basket.result.current.list()).toEqual([]);

    await user.clear(screen.getByRole("textbox", { name: "Link 2 URL" }));
    await user.type(screen.getByRole("textbox", { name: "Link 2 URL" }), "mailto:team@example.com");
    await user.click(screen.getByRole("button", { name: "Save links" }));
    expect(basket.result.current.list()).toEqual([
      {
        kind: "setLinks",
        id: "acme-002",
        from: [{ title: "Spec", url: "https://example.com/spec" }],
        to: [
          { title: "Spec", url: "https://example.com/spec" },
          { title: "Bad", url: "mailto:team@example.com" },
        ],
      },
    ]);

    await user.click(screen.getByRole("button", { name: "Remove link 1" }));
    await user.click(screen.getByRole("button", { name: "Save links" }));
    expect(basket.result.current.list()).toEqual([
      {
        kind: "setLinks",
        id: "acme-002",
        from: [{ title: "Spec", url: "https://example.com/spec" }],
        to: [{ title: "Bad", url: "mailto:team@example.com" }],
      },
    ]);
  });
});
