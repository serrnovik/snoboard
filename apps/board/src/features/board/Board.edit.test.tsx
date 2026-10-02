// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import type { BoardItem, RefInfo } from "snoboard/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageActionsProvider } from "@/components/page-actions";
import { browserLocation } from "@/features/board/sync";
import { basketStorageKey, resetBasketStore, useBasket } from "@/features/basket/store";
import { Board } from "@/features/board/Board";
import type { BoardPayload } from "@/features/board/model";
import { renderHook } from "@testing-library/react";

const NOW = Date.parse("2026-09-29T15:00:00.000Z");
const rects = new WeakMap<Element, DOMRect>();

function item(overrides: Partial<BoardItem> & Pick<BoardItem, "id" | "title" | "status" | "priority">): BoardItem {
  return {
    depends_on: [],
    updated: "2026-09-29",
    path: `initiatives/acme/${overrides.id}/initiative.md`,
    project: "acme",
    number: overrides.id.slice(-3),
    summary: "",
    sourceRef: "main",
    sourceSha: "abc",
    updatedAt: "2026-09-29T00:00:00.000Z",
    isReady: false,
    blockedBy: [],
    onBranches: ["main"],
    ...overrides,
  };
}

function payload(items: BoardItem[]): BoardPayload {
  const refs: RefInfo[] = [{ name: "main", sha: "abc", isDefault: true }];
  return {
    status: { lastFetchAt: "2026-09-29T14:55:00.000Z", lastError: null, lastErrorAt: null, refreshing: false },
    config: {
      statuses: ["planned", "in-progress", "review", "done"],
      priorities: ["p0", "p1", "p2", "p3"],
      doneStatuses: ["done"],
    },
    items,
    legacy: [],
    errors: [],
    refs,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockBoard(body: BoardPayload, enabled: boolean) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/refresh") && init?.method === "POST") return json({ accepted: true }, 202);
      if (url.endsWith("/edit-config")) {
        return json({
          enabled,
          modes: enabled ? ["direct"] : [],
          baseBranch: "main",
          ...(enabled ? { directBranch: "main" } : {}),
          canSubmit: false,
          needsGithubWrite: false,
          defaultMode: enabled ? "direct" : "pr",
        });
      }
      if (url.endsWith("/board")) return json(body);
      return json({ error: "not found" }, 404);
    }),
  );
}

function TopBar({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <PageActionsProvider element={slot}>
      <header>
        <div ref={setSlot} />
      </header>
      {children}
    </PageActionsProvider>
  );
}

function placeColumns() {
  const columns = ["planned", "in-progress", "review", "done"];
  columns.forEach((status, index) => {
    const column = screen.getByTestId(`column-${status}`);
    const x = index * 320;
    rects.set(column, new DOMRect(x, 0, 280, 700));
    for (const [itemIndex, node] of column.querySelectorAll("[data-slot='kanban-item']").entries()) {
      rects.set(node, new DOMRect(x + 12, 90 + itemIndex * 150, 250, 130));
    }
  });
}

function cardIds(status: string): string[] {
  return within(screen.getByTestId(`column-${status}`))
    .queryAllByTestId(/^card-/)
    .map((card) => card.getAttribute("data-testid")?.replace("card-", "") ?? "");
}

beforeEach(() => {
  vi.spyOn(browserLocation, "assign").mockImplementation((path: string) => {
    window.history.replaceState(null, "", path);
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function rectOf(this: HTMLElement) {
    return rects.get(this) ?? new DOMRect(0, 0, 10, 10);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  resetBasketStore();
  window.history.replaceState(null, "", "/");
});

describe("board editing", () => {
  const cards = [
    item({ id: "acme-003", title: "Reports", status: "planned", priority: "p1" }),
    item({ id: "acme-002", title: "Billing", status: "in-progress", priority: "p1" }),
  ];

  it("renders nothing for the basket when editing is off", async () => {
    mockBoard(payload(cards), false);
    render(<Board pollIntervalMs={0} now={NOW} />);
    expect(await screen.findByTestId("card-acme-003")).toBeTruthy();
    expect(screen.queryByTestId("basket-panel")).toBeNull();
    expect(screen.queryByTestId("drag-acme-003")).toBeNull();
    expect(screen.queryByRole("button", { name: "New initiative" })).toBeNull();
  });

  it("moves a card into the pending column and shows the badge", async () => {
    localStorage.setItem(
      basketStorageKey("default"),
      JSON.stringify([{ kind: "setStatus", id: "acme-003", from: "planned", to: "review" }]),
    );
    mockBoard(payload(cards), true);
    render(
      <TopBar>
        <Board pollIntervalMs={0} now={NOW} />
      </TopBar>,
    );
    expect(await screen.findByTestId("basket-panel")).toBeTruthy();
    expect(screen.getByTestId("basket-count").textContent).toBe("1");
    await waitFor(() => expect(cardIds("review")).toEqual(["acme-003"]));
    expect(cardIds("planned")).toEqual([]);
    const card = screen.getByTestId("card-acme-003");
    expect(within(card).getByTestId("pending-badge").textContent).toBe("pending");
    expect(within(card).getByText("planned → review")).toBeTruthy();
    expect(document.querySelector("header")?.textContent).toContain("New initiative");
  });

  it("does not edit while dragging, highlights the target, and queues the edit on drop", async () => {
    mockBoard(payload(cards), true);
    const basket = renderHook(() => useBasket());
    render(<Board pollIntervalMs={0} now={NOW} />);
    expect(await screen.findByTestId("drag-acme-003")).toBeTruthy();
    placeColumns();

    pointerDown(screen.getByTestId("drag-acme-003"));
    pointerMove(320 + 40, 120);

    await waitFor(() => expect(screen.getByTestId("column-in-progress").getAttribute("data-drop-target")).toBe("true"));
    const target = screen.getByTestId("column-in-progress");
    expect(target.className).toContain("ring-2");
    expect(target.className).toContain("bg-primary/10");
    expect(within(target).getByTestId("drop-placeholder")).toBeTruthy();
    expect(screen.getByTestId("column-planned").hasAttribute("data-drop-target")).toBe(false);
    expect(cardIds("planned")).toContain("acme-003");
    expect(cardIds("in-progress")).not.toContain("acme-003");
    expect(basket.result.current.list()).toEqual([]);

    pointerUp(320 + 40, 120);
    await waitFor(() => expect(cardIds("in-progress")).toContain("acme-003"));
    expect(basket.result.current.list()).toEqual([
      { kind: "setStatus", id: "acme-003", from: "planned", to: "in-progress" },
    ]);
    expect((screen.getByTestId("edit-label").textContent ?? "").replace(/\s+/g, " ").trim()).toBe(
      "acme-003 · Reports — planned → in-progress",
    );
    expect(screen.getByTestId("edit-label-title").getAttribute("title")).toBe("Reports");
    expect(screen.getByTestId("column-in-progress").hasAttribute("data-drop-target")).toBe(false);
    expect(screen.queryByTestId("drop-placeholder")).toBeNull();
  });

  it("drops on the original column or outside the board without an edit", async () => {
    mockBoard(payload(cards), true);
    const basket = renderHook(() => useBasket());
    render(<Board pollIntervalMs={0} now={NOW} />);
    expect(await screen.findByTestId("drag-acme-003")).toBeTruthy();
    placeColumns();

    pointerDown(screen.getByTestId("drag-acme-003"));
    pointerMove(40, 120);
    pointerUp(40, 120);
    expect(basket.result.current.list()).toEqual([]);
    expect(cardIds("planned")).toContain("acme-003");

    placeColumns();
    pointerDown(screen.getByTestId("drag-acme-003"));
    pointerMove(320 + 40, 120);
    await waitFor(() => expect(screen.getByTestId("column-in-progress").getAttribute("data-drop-target")).toBe("true"));
    pointerMove(-80, -80);
    pointerUp(-80, -80);
    expect(basket.result.current.list()).toEqual([]);
    expect(cardIds("planned")).toContain("acme-003");
    expect(cardIds("in-progress")).not.toContain("acme-003");
    expect(screen.queryByTestId("drop-placeholder")).toBeNull();
  });

  it("queues setStatus when a card is dropped, and clears it when dropped back on the snapshot column", async () => {
    mockBoard(payload(cards), true);
    const basket = renderHook(() => useBasket());
    render(<Board pollIntervalMs={0} now={NOW} />);
    expect(await screen.findByTestId("drag-acme-003")).toBeTruthy();
    placeColumns();

    drag(screen.getByTestId("drag-acme-003"), 320 + 40, 120);
    await waitFor(() => expect(cardIds("in-progress")).toContain("acme-003"));
    expect(basket.result.current.list()).toEqual([
      { kind: "setStatus", id: "acme-003", from: "planned", to: "in-progress" },
    ]);

    placeColumns();
    drag(screen.getByTestId("drag-acme-003"), 40, 120);
    await waitFor(() => expect(cardIds("planned")).toContain("acme-003"));
    expect(basket.result.current.list()).toEqual([]);
  });

  it("accepts drops on a folded column", async () => {
    localStorage.setItem("snoboard:folded-columns:v1:default", JSON.stringify(["review"]));
    mockBoard(payload(cards), true);
    const basket = renderHook(() => useBasket());
    render(<Board pollIntervalMs={0} now={NOW} />);
    expect(await screen.findByTestId("drag-acme-003")).toBeTruthy();
    await screen.findByRole("button", { name: "Unfold Review" });
    placeColumns();

    pointerDown(screen.getByTestId("drag-acme-003"));
    pointerMove(640 + 20, 120);
    await waitFor(() => expect(screen.getByTestId("column-review").getAttribute("data-drop-target")).toBe("true"));
    expect(screen.getByTestId("column-review").className).toContain("ring-2");
    expect(basket.result.current.list()).toEqual([]);
    pointerUp(640 + 20, 120);
    await waitFor(() =>
      expect(basket.result.current.list()).toEqual([{ kind: "setStatus", id: "acme-003", from: "planned", to: "review" }]),
    );
    expect(cardIds("planned")).not.toContain("acme-003");
    expect(screen.getByTestId("count-review").textContent).toBe("1");
  });
});

function pointerDown(handle: HTMLElement) {
  const start = handle.getBoundingClientRect();
  const down = { button: 0, buttons: 1, clientX: start.left + 8, clientY: start.top + 8 };
  fireEvent.mouseDown(handle, down);
  fireEvent.mouseMove(document, { button: 0, buttons: 1, clientX: down.clientX + 20, clientY: down.clientY + 12 });
}

function pointerMove(clientX: number, clientY: number) {
  fireEvent.mouseMove(document, { button: 0, buttons: 1, clientX, clientY });
}

function pointerUp(clientX: number, clientY: number) {
  fireEvent.mouseUp(document, { button: 0, buttons: 1, clientX, clientY });
}

function drag(handle: HTMLElement, clientX: number, clientY: number) {
  pointerDown(handle);
  pointerMove(clientX, clientY);
  pointerUp(clientX, clientY);
}

describe("basket-aware board", () => {
  it("shows a dependent as ready (pending) once its dependency is moved to done in the basket", async () => {
    localStorage.setItem(
      basketStorageKey("default"),
      JSON.stringify([{ kind: "setStatus", id: "acme-001", from: "in-progress", to: "done" }]),
    );
    resetBasketStore();
    mockBoard(
      payload([
        item({ id: "acme-001", title: "Dependency", status: "in-progress", priority: "p1", isReady: true }),
        item({ id: "acme-002", title: "Dependent", status: "planned", priority: "p1", depends_on: ["acme-001"], blockedBy: ["acme-001"] }),
      ]),
      true,
    );
    render(<Board pollIntervalMs={0} now={NOW} />);
    const card = await screen.findByTestId("card-acme-002");
    await waitFor(() => expect(within(card).getByTestId("ready-badge").textContent).toContain("ready (pending)"));
    expect(within(card).queryByText(/blocked/)).toBeNull();
    expect(cardIds("done")).toEqual(["acme-001"]);
  });

  it("offers an only-this-session age that shows just pending moves", async () => {
    localStorage.setItem(
      basketStorageKey("default"),
      JSON.stringify([{ kind: "setStatus", id: "acme-001", from: "in-progress", to: "done" }]),
    );
    resetBasketStore();
    mockBoard(
      payload([
        item({ id: "acme-001", title: "Moved", status: "in-progress", priority: "p1", updated: "2026-01-01", updatedAt: "2026-01-01T00:00:00.000Z" }),
        item({ id: "acme-003", title: "Recent done", status: "done", priority: "p1" }),
      ]),
      true,
    );
    render(<Board pollIntervalMs={0} now={NOW} />);
    const age = await screen.findByRole("combobox", { name: "Show Done changed within" });
    await waitFor(() => expect(within(age).queryByRole("option", { name: "Only this session's changes" })).not.toBeNull());
    fireEvent.change(age, { target: { value: "session" } });
    await waitFor(() => expect(cardIds("done")).toEqual(["acme-001"]));
  });
});
