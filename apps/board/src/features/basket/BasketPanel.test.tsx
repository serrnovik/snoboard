// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderHook } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BasketPanel } from "@/features/basket/BasketPanel";
import { resetBasketStore, useBasket } from "@/features/basket/store";

function lineText(testId: string): string {
  return (screen.getByTestId(testId).textContent ?? "").replace(/\s+/g, " ").trim();
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  resetBasketStore();
  vi.unstubAllGlobals();
});

describe("basket panel", () => {
  it("stays hidden when editing is off", () => {
    render(<BasketPanel enabled={false} />);
    expect(screen.queryByTestId("basket-panel")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Basket" })).toBeNull();
  });

  it("lists edits, shows the count, and removes them", async () => {
    const user = userEvent.setup();
    const { result } = renderHook(() => useBasket());
    render(<BasketPanel enabled titles={new Map([["acme-002", "Billing"]])} />);
    expect(screen.getByTestId("basket-count").textContent).toBe("0");
    expect(screen.getByText("No pending edits.")).toBeTruthy();

    act(() => {
      result.current.add({ kind: "setStatus", id: "acme-002", from: "planned", to: "review" });
    });
    expect(screen.getByTestId("basket-count").textContent).toBe("1");
    expect(lineText("edit-label")).toBe("acme-002 · Billing — planned → review");

    await user.click(screen.getByRole("button", { name: "Remove acme-002 · Billing — planned → review" }));
    expect(screen.getByText("No pending edits.")).toBeTruthy();
    expect(result.current.list()).toEqual([]);
  });

  it("shows the snapshot title, truncates it, and falls back when the title is unknown", () => {
    const { result } = renderHook(() => useBasket());
    const longTitle = "Gantt export for the quarterly planning review";
    act(() => {
      result.current.add({ kind: "setStatus", id: "acme-024", from: "planned", to: "done" });
      result.current.add({ kind: "setPriority", id: "acme-009", from: "p2", to: "p0" });
      result.current.add({
        kind: "createInitiative",
        project: "acme",
        slug: "gamma",
        title: "Gamma export",
        status: "planned",
        priority: "p2",
      });
    });
    render(<BasketPanel enabled titles={new Map([["acme-024", longTitle]])} />);

    const lines = screen.getAllByTestId("edit-label").map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim());
    expect(lines).toContain(`acme-024 · ${longTitle} — planned → done`);
    expect(lines).toContain("acme-009 · acme-009 — priority p2 → p0");
    expect(lines).toContain("acme/gamma · Gamma export — create");

    const titled = screen.getAllByTestId("edit-label-title");
    const known = titled.find((node) => node.textContent === longTitle);
    expect(known?.getAttribute("title")).toBe(longTitle);
    expect(known?.className).toContain("truncate");
    const fallback = titled.find((node) => node.textContent === "acme-009");
    expect(fallback?.getAttribute("title")).toBe("acme-009");
    expect(screen.getByText("Gamma export").getAttribute("title")).toBe("Gamma export");
  });

  it("explains read-only sign-in and does not offer submit", () => {
    render(<BasketPanel enabled canSubmit={false} />);
    expect(screen.getByTestId("submit-readonly").textContent).toContain("not submit edits");
    expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
  });

  it("offers submit when this sign-in can send edits", () => {
    const { result } = renderHook(() => useBasket());
    act(() => {
      result.current.add({ kind: "setStatus", id: "acme-002", from: "planned", to: "review" });
    });
    render(<BasketPanel enabled canSubmit />);
    expect(screen.queryByTestId("submit-readonly")).toBeNull();
    expect(screen.getByRole("button", { name: "Submit" })).toBeTruthy();
  });

  it("keeps the pull request link on screen after the submit empties the basket", async () => {
    const user = userEvent.setup();
    const { result } = renderHook(() => useBasket());
    act(() => {
      result.current.add({ kind: "setStatus", id: "acme-002", from: "planned", to: "review" });
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      const reply = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      if (url.endsWith("/edit-config")) {
        return reply({ enabled: true, modes: ["pr"], baseBranch: "main", canSubmit: true, needsGithubWrite: false, defaultMode: "pr", csrf: "t" });
      }
      if (url.endsWith("/edits/validate")) return reply({ results: [{ index: 0, ok: true }] });
      return reply({ ok: true, mode: "pr", commit: "abc1234", branch: "snoboard/edits-x", pr: { number: 9, url: "https://github.com/a/b/pull/9" } });
    });
    render(<BasketPanel enabled canSubmit />);
    await user.click(screen.getByRole("button", { name: "Submit" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByTestId("validate-result");
    await user.click(within(dialog).getByRole("button", { name: "Submit edits" }));
    expect((await within(dialog).findByTestId("submit-pr")).textContent).toContain("#9");
    expect(screen.getByTestId("basket-count").textContent).toBe("0");
  });
});
