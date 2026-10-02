// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import type { BoardItem, LegacyItem, RefInfo } from "snoboard/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBasketStore } from "@/features/basket/store";
import { Board } from "@/features/board/Board";
import type { BoardPayload } from "@/features/board/model";
import { browserLocation } from "@/features/board/sync";

const NOW = Date.parse("2026-09-29T15:00:00.000Z");

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

function legacy(overrides: Partial<LegacyItem> = {}): LegacyItem {
  return {
    path: "initiatives/platform/001-ci/initiative.md",
    project: "platform",
    number: "001",
    title: "Continuous integration",
    summary: "Run checks on every change.",
    ...overrides,
  };
}

function payload(overrides: Partial<BoardPayload> = {}): BoardPayload {
  const refs: RefInfo[] = overrides.refs ?? [
    { name: "main", sha: "abc", isDefault: true },
  ];
  return {
    status: {
      lastFetchAt: "2026-09-29T14:55:00.000Z",
      lastError: null,
      lastErrorAt: null,
      refreshing: false,
    },
    config: {
      statuses: ["planned", "in-progress", "done"],
      priorities: ["p0", "p1", "p2", "p3"],
      doneStatuses: ["done"],
    },
    items: [],
    legacy: [],
    errors: [],
    refs,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockBoard(body: BoardPayload | { error: string }, status = 200) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/refresh") && init?.method === "POST") {
      return jsonResponse({ accepted: true }, 202);
    }
    if (url.endsWith("/board")) return jsonResponse(body, status);
    return jsonResponse({ error: "not found" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function cardIds(status: string): string[] {
  const column = screen.getByTestId(`column-${status}`);
  return within(column)
    .getAllByTestId(/^card-/)
    .map((card) => card.getAttribute("data-testid")?.replace("card-", "") ?? "");
}

beforeEach(() => {
  vi.spyOn(browserLocation, "assign").mockImplementation((path: string) => {
    window.history.replaceState(null, "", path);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
  document.documentElement.classList.remove("dark");
  localStorage.clear();
  resetBasketStore();
});

describe("board view", () => {
  it("places cards in status columns, sorted by priority then updated", async () => {
    mockBoard(
      payload({
        items: [
          item({ id: "acme-010", title: "Older critical", status: "in-progress", priority: "p0", updated: "2026-08-01", isReady: true }),
          item({ id: "acme-011", title: "Newer critical", status: "in-progress", priority: "p0", updated: "2026-09-20", isReady: true }),
          item({ id: "acme-002", title: "Billing", status: "in-progress", priority: "p1", updated: "2026-09-28", isReady: true }),
          item({ id: "acme-003", title: "Reports", status: "planned", priority: "p2", updated: "2026-09-29", isReady: false, blockedBy: ["acme-002"] }),
          item({
            id: "acme-001",
            title: "Customer onboarding",
            status: "done",
            priority: "p1",
            updated: "2026-09-20",
            labels: ["signup"],
            phases: [
              { id: 1, title: "Account setup", status: "done" },
              { id: 2, title: "First project", status: "done" },
              { id: 3, title: "Invite", status: "planned" },
            ],
          }),
        ],
      }),
    );

    render(<Board pollIntervalMs={0} now={NOW} />);

    expect(await screen.findByRole("heading", { name: "In progress" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Planned" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Done" })).toBeTruthy();
    expect(cardIds("in-progress")).toEqual(["acme-011", "acme-010", "acme-002"]);
    expect(cardIds("planned")).toEqual(["acme-003"]);
    expect(cardIds("done")).toEqual(["acme-001"]);
    expect(screen.getByLabelText("Phase progress 2/3")).toBeTruthy();
    expect(screen.getByText("2/3")).toBeTruthy();
  });

  it("shows ready, blocked, branch, and priority badges", async () => {
    const user = userEvent.setup();
    mockBoard(
      payload({
        items: [
          item({
            id: "acme-002",
            title: "Billing",
            status: "in-progress",
            priority: "p1",
            isReady: true,
            labels: ["payments"],
            sourceRef: "initiative/acme-002-billing",
          }),
          item({
            id: "acme-004",
            title: "Outage",
            status: "planned",
            priority: "p0",
            isReady: false,
            blockedBy: ["acme-002", "acme-009"],
          }),
          item({
            id: "acme-005",
            title: "Polish",
            status: "planned",
            priority: "p3",
            isReady: true,
          }),
          item({
            id: "acme-001",
            title: "Customer onboarding",
            status: "done",
            priority: "p2",
            isReady: false,
            sourceRef: "main",
          }),
        ],
      }),
    );

    render(<Board pollIntervalMs={0} now={NOW} />);
    const billing = await screen.findByRole("article", { name: "acme-002: Billing" });
    const readyBadge = within(billing).getByText("ready");
    expect(readyBadge.querySelector("svg[data-icon='check']")).toBeTruthy();
    expect(readyBadge.className).toContain("emerald");
    const branchText = within(billing).getByText("initiative/acme-002-billing");
    expect(branchText.className).toContain("truncate");
    const branchBadge = branchText.closest("[data-slot='badge']");
    expect(branchBadge?.getAttribute("title")).toBe("initiative/acme-002-billing");
    expect(branchBadge?.querySelector("svg[data-icon='git-branch']")).toBeTruthy();
    expect(branchBadge?.className).toContain("bg-muted");
    const labelBadge = within(billing).getByText("payments");
    expect(labelBadge.getAttribute("data-variant")).toBe("secondary");
    expect(labelBadge.querySelector("svg")).toBeNull();
    expect(within(billing).getByText("p1").getAttribute("data-variant")).toBe("default");
    expect(billing.querySelector("[aria-roledescription='sortable']")).toBeNull();
    expect(billing.querySelector("button")).toBeNull();

    const outage = screen.getByRole("article", { name: "acme-004: Outage" });
    const blockedBadge = within(outage).getByText("blocked");
    expect(blockedBadge.querySelector("svg[data-icon='lock']")).toBeTruthy();
    expect(blockedBadge.className).toContain("amber");
    expect(within(outage).queryByText("ready")).toBeNull();
    expect(within(outage).getByText("p0").getAttribute("data-variant")).toBe("destructive");
    await user.hover(within(outage).getByRole("button", { name: "Blocked by acme-002, acme-009" }));
    expect(await screen.findByText("Blocked by acme-002, acme-009")).toBeTruthy();

    const polish = screen.getByRole("article", { name: "acme-005: Polish" });
    expect(within(polish).getByText("p3").getAttribute("data-variant")).toBe("outline");
    const done = screen.getByRole("article", { name: "acme-001: Customer onboarding" });
    expect(within(done).queryByText("ready")).toBeNull();
    expect(within(done).queryByText("blocked")).toBeNull();
    expect(within(done).queryByText("main")).toBeNull();
    expect(within(done).getByText("p2").getAttribute("data-variant")).toBe("outline");
    expect(screen.getByRole("heading", { name: "Planned" })).toBeTruthy();
    expect(document.querySelector("[aria-roledescription='sortable']")).toBeNull();
  });

  it("keeps the done column to the last 14 days until show all", async () => {
    const user = userEvent.setup();
    mockBoard(
      payload({
        items: [
          item({ id: "acme-001", title: "Recent done", status: "done", priority: "p1", updated: "2026-09-20" }),
          item({
            id: "acme-008",
            title: "Old done",
            status: "done",
            priority: "p0",
            updated: "2026-08-01",
            updatedAt: "2026-08-01T00:00:00.000Z",
          }),
        ],
      }),
    );

    render(<Board pollIntervalMs={0} now={NOW} />);
    expect(await screen.findByTestId("card-acme-001")).toBeTruthy();
    expect(screen.queryByTestId("card-acme-008")).toBeNull();
    expect(screen.getByTestId("count-done").textContent).toBe("2 · 1 shown");
    const age = screen.getByRole("combobox", { name: "Show Done changed within" });
    expect((age as HTMLSelectElement).value).toBe("2w");
    await user.selectOptions(age, "all");
    expect(cardIds("done")).toEqual(["acme-008", "acme-001"]);
    expect(screen.getByTestId("count-done").textContent).toBe("2");
    expect(JSON.parse(localStorage.getItem("snoboard:closed-age:v1:default") ?? "{}")).toEqual({ done: "all" });
  });

  it("still honours the legacy done=all URL", async () => {
    window.history.replaceState(null, "", "/?done=all");
    mockBoard(
      payload({
        items: [
          item({ id: "acme-008", title: "Old done", status: "done", priority: "p0", updated: "2026-08-01", updatedAt: "2026-08-01T00:00:00.000Z" }),
        ],
      }),
    );
    render(<Board pollIntervalMs={0} now={NOW} />);
    expect(await screen.findByTestId("card-acme-008")).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Show Done changed within" }) as HTMLSelectElement).value).toBe("all");
  });

  it("keeps closed=all URLs working and drops the override when a column age is picked", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/?closed=all");
    mockBoard(
      payload({
        items: [
          item({ id: "acme-008", title: "Old done", status: "done", priority: "p0", updated: "2026-08-01", updatedAt: "2026-08-01T00:00:00.000Z" }),
          item({ id: "acme-009", title: "Week-old done", status: "done", priority: "p0", updated: "2026-09-25", updatedAt: "2026-09-25T00:00:00.000Z" }),
        ],
      }),
    );
    render(<Board pollIntervalMs={0} now={NOW} />);
    expect(await screen.findByTestId("card-acme-008")).toBeTruthy();
    await user.selectOptions(screen.getByRole("combobox", { name: "Show Done changed within" }), "1d");
    expect(new URLSearchParams(window.location.search).get("closed")).toBeNull();
    expect(within(screen.getByTestId("column-done")).queryAllByTestId(/^card-/)).toEqual([]);
    await user.selectOptions(screen.getByRole("combobox", { name: "Show Done changed within" }), "1w");
    expect(cardIds("done")).toEqual(["acme-009"]);
    await user.selectOptions(screen.getByRole("combobox", { name: "Show Done changed within" }), "1m");
    expect(cardIds("done")).toEqual(["acme-009"]);
  });

  it("restores the stored column age and sort per repo", async () => {
    localStorage.setItem("snoboard:closed-age:v1:default", JSON.stringify({ done: "all", bogus: "x" }));
    localStorage.setItem("snoboard:column-sort:v1:default", JSON.stringify({ planned: "title" }));
    mockBoard(
      payload({
        items: [
          item({ id: "acme-008", title: "Old done", status: "done", priority: "p0", updated: "2026-08-01", updatedAt: "2026-08-01T00:00:00.000Z" }),
          item({ id: "acme-001", title: "Zulu", status: "planned", priority: "p0" }),
          item({ id: "acme-002", title: "alpha", status: "planned", priority: "p3" }),
        ],
      }),
    );
    render(<Board pollIntervalMs={0} now={NOW} />);
    expect(await screen.findByTestId("card-acme-008")).toBeTruthy();
    expect(cardIds("planned")).toEqual(["acme-002", "acme-001"]);
    expect((screen.getByRole("combobox", { name: "Sort Planned" }) as HTMLSelectElement).value).toBe("title");
  });

  it("sorts each column by priority, last change, title or id", async () => {
    const user = userEvent.setup();
    mockBoard(
      payload({
        items: [
          item({ id: "acme-010", title: "Charlie", status: "planned", priority: "p2", updated: "2026-09-01", updatedAt: "2026-09-28T00:00:00.000Z" }),
          item({ id: "acme-002", title: "bravo", status: "planned", priority: "p0", updated: "2026-09-10", updatedAt: "2026-09-10T00:00:00.000Z" }),
          item({ id: "acme-003", title: "Alpha", status: "planned", priority: "p1", updated: "2026-09-20", updatedAt: "2026-09-20T00:00:00.000Z" }),
          item({ id: "acme-020", title: "Other", status: "in-progress", priority: "p3" }),
        ],
      }),
    );
    render(<Board pollIntervalMs={0} now={NOW} />);
    expect(await screen.findByTestId("card-acme-010")).toBeTruthy();
    expect(cardIds("planned")).toEqual(["acme-002", "acme-003", "acme-010"]);
    const sort = screen.getByRole("combobox", { name: "Sort Planned" });
    await user.selectOptions(sort, "changed");
    expect(cardIds("planned")).toEqual(["acme-010", "acme-003", "acme-002"]);
    await user.selectOptions(sort, "title");
    expect(cardIds("planned")).toEqual(["acme-003", "acme-002", "acme-010"]);
    await user.selectOptions(sort, "id");
    expect(cardIds("planned")).toEqual(["acme-002", "acme-003", "acme-010"]);
    expect(JSON.parse(localStorage.getItem("snoboard:column-sort:v1:default") ?? "{}")).toEqual({ planned: "id" });
    expect((screen.getByRole("combobox", { name: "Sort In progress" }) as HTMLSelectElement).value).toBe("priority");
  });

  it("limits parked and dropped columns to recent changes with per-column toggles", async () => {
    const user = userEvent.setup();
    const old = { updated: "2026-07-01", updatedAt: "2026-07-01T00:00:00.000Z" };
    mockBoard(
      payload({
        config: {
          statuses: ["planned", "parked", "dropped", "done"],
          priorities: ["p0", "p1", "p2", "p3"],
          doneStatuses: ["done"],
        },
        items: [
          item({ id: "acme-001", title: "Old plan", status: "planned", priority: "p1", ...old }),
          // Frontmatter is old but the last commit is recent: counts as recent.
          item({ id: "acme-002", title: "Recent park", status: "parked", priority: "p1", updated: "2026-07-01", updatedAt: "2026-09-25T10:00:00.000Z" }),
          item({ id: "acme-003", title: "Old park", status: "parked", priority: "p1", ...old }),
          item({ id: "acme-004", title: "Old park 2", status: "parked", priority: "p2", ...old }),
          item({ id: "acme-005", title: "Old drop", status: "dropped", priority: "p1", ...old }),
        ],
      }),
    );

    render(<Board pollIntervalMs={0} now={NOW} />);
    expect(await screen.findByTestId("card-acme-002")).toBeTruthy();
    expect(cardIds("planned")).toEqual(["acme-001"]);
    expect(cardIds("parked")).toEqual(["acme-002"]);
    expect(within(screen.getByTestId("column-dropped")).queryAllByTestId(/^card-/)).toEqual([]);
    expect(screen.getByTestId("count-parked").textContent).toBe("3 · 1 shown");
    expect(screen.getByTestId("count-dropped").textContent).toBe("1 · 0 shown");
    expect(screen.getByTestId("count-planned").textContent).toBe("1");

    const parked = screen.getByTestId("column-parked");
    await user.selectOptions(within(parked).getByRole("combobox", { name: "Show Parked changed within" }), "all");
    expect(cardIds("parked")).toEqual(["acme-002", "acme-003", "acme-004"]);
    expect(within(screen.getByTestId("column-dropped")).queryAllByTestId(/^card-/)).toEqual([]);

    await user.selectOptions(within(parked).getByRole("combobox", { name: "Show Parked changed within" }), "2w");
    expect(cardIds("parked")).toEqual(["acme-002"]);
    expect(within(screen.getByTestId("column-planned")).queryByRole("combobox", { name: /changed within/ })).toBeNull();
  });

  it("folds and unfolds columns, persisted per repo", async () => {
    const user = userEvent.setup();
    mockBoard(
      payload({
        items: [item({ id: "acme-003", title: "Reports", status: "planned", priority: "p2" })],
      }),
    );
    const first = render(<Board pollIntervalMs={0} now={NOW} />);
    expect(await screen.findByTestId("card-acme-003")).toBeTruthy();
    const fold = screen.getByRole("button", { name: "Fold Planned" });
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    await user.click(fold);
    const unfold = screen.getByRole("button", { name: "Unfold Planned" });
    expect(unfold.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("column-planned").getAttribute("data-folded")).toBe("true");
    expect(screen.queryByTestId("card-acme-003")).toBeNull();
    expect(screen.getByTestId("count-planned").textContent).toBe("1");
    expect(JSON.parse(localStorage.getItem("snoboard:folded-columns:v1:default") ?? "[]")).toEqual(["planned"]);

    first.unmount();
    render(<Board pollIntervalMs={0} now={NOW} />);
    const again = await screen.findByRole("button", { name: "Unfold Planned" });
    expect(screen.getByRole("button", { name: "Fold Done" }).getAttribute("aria-expanded")).toBe("true");
    again.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByTestId("card-acme-003")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Fold Planned" }).getAttribute("aria-expanded")).toBe("true");
    expect(JSON.parse(localStorage.getItem("snoboard:folded-columns:v1:default") ?? "[]")).toEqual([]);
  });

  it("shows a collapsed legacy section when the URL has legacy=1", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/?legacy=1");
    mockBoard(payload({ legacy: [legacy()] }));

    render(<Board pollIntervalMs={0} now={NOW} />);
    const toggle = await screen.findByRole("switch", { name: "Show legacy" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    const details = screen.getByText("Legacy (1)").closest("details");
    expect(details).toBeTruthy();
    expect(details?.hasAttribute("open")).toBe(false);
    expect(screen.getByText("Continuous integration")).toBeTruthy();
    expect(screen.getByText("initiatives/platform/001-ci/initiative.md")).toBeTruthy();

    await user.click(toggle);
    expect(window.location.search).not.toContain("legacy=");
    expect(screen.queryByText("Legacy (1)")).toBeNull();
    expect(screen.queryByText("Continuous integration")).toBeNull();
  });

  it("persists filters in the URL and reveals legacy initiatives", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/?priority=p1");
    mockBoard(
      payload({
        items: [
          item({
            id: "acme-002",
            title: "Billing",
            status: "in-progress",
            priority: "p1",
            project: "acme",
            labels: ["payments"],
            isReady: true,
          }),
          item({
            id: "billing-004",
            title: "Invoices",
            status: "planned",
            priority: "p2",
            project: "billing",
            labels: ["finance"],
            isReady: true,
          }),
        ],
        legacy: [legacy()],
      }),
    );

    render(<Board pollIntervalMs={0} now={NOW} />);
    expect(await screen.findByTestId("card-acme-002")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Project" }).textContent).toContain("All projects");
    expect(screen.getByRole("combobox", { name: "Label" }).textContent).toContain("All labels");
    expect(screen.getByRole("combobox", { name: "Priority" }).textContent).toContain("p1");
    expect(screen.queryByText("__all__")).toBeNull();
    expect(screen.queryByTestId("card-billing-004")).toBeNull();
    expect(screen.queryByText("Continuous integration")).toBeNull();

    await user.click(screen.getByRole("combobox", { name: "Priority" }));
    await user.click(await screen.findByRole("option", { name: "All priorities" }));
    expect(window.location.search).not.toContain("priority=");
    expect(screen.getByRole("combobox", { name: "Priority" }).textContent).toContain("All priorities");
    expect(screen.queryByText("__all__")).toBeNull();

    await user.type(screen.getByRole("searchbox", { name: "Search id or title" }), "invoice");
    expect(window.location.search).toContain("q=invoice");
    expect(screen.queryByTestId("card-acme-002")).toBeNull();
    expect(screen.getByTestId("card-billing-004")).toBeTruthy();

    await user.click(screen.getByRole("combobox", { name: "Project" }));
    await user.click(await screen.findByRole("option", { name: "billing" }));
    expect(window.location.search).toContain("project=billing");

    await user.click(screen.getByRole("combobox", { name: "Label" }));
    await user.click(await screen.findByRole("option", { name: "finance" }));
    expect(window.location.search).toContain("label=finance");

    await user.click(screen.getByRole("switch", { name: "Show legacy" }));
    expect(window.location.search).toContain("legacy=1");
    expect(screen.getByText("Continuous integration")).toBeTruthy();
    expect(screen.getByText("initiatives/platform/001-ci/initiative.md")).toBeTruthy();
  });

  it("shows the empty state and posts refresh, keeping the last error visible", async () => {
    const user = userEvent.setup();
    const fetchMock = mockBoard(payload({ items: [], legacy: [] }));
    render(<Board pollIntervalMs={0} now={NOW} />);
    expect(await screen.findByText("No Snoboard initiatives yet — run `snoboard new`")).toBeTruthy();
    expect(screen.getByText(/5 minutes ago/)).toBeTruthy();
    expect(screen.queryByTestId("board-scroller")).toBeNull();

    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/refresh") && init?.method === "POST") {
        return jsonResponse({ accepted: true }, 202);
      }
      return jsonResponse(
        payload({
          status: {
            lastFetchAt: "2026-09-29T14:55:00.000Z",
            lastError: "Remote fetch failed",
            lastErrorAt: "2026-09-29T14:50:00.000Z",
            refreshing: false,
          },
          items: [item({ id: "acme-002", title: "Billing", status: "in-progress", priority: "p1", isReady: true })],
        }),
      );
    });
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Remote fetch failed")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Remote fetch failed");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/repos/default/refresh",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("shows the request error when the board cannot be loaded", async () => {
    mockBoard({ error: "snapshot not ready" }, 503);
    render(<Board pollIntervalMs={0} now={NOW} />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("snapshot not ready")).toBeTruthy();
  });

  it("retries soon while the first snapshot is not ready", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (!String(input).endsWith("/board")) return jsonResponse({ error: "not found" }, 404);
        calls += 1;
        if (calls === 1) return jsonResponse({ error: "snapshot not ready" }, 503);
        return jsonResponse(payload({ items: [item({ id: "acme-001", title: "Ready now", status: "planned", priority: "p1" })] }));
      }),
    );
    render(<Board pollIntervalMs={0} now={NOW} />);
    expect(await screen.findByText("snapshot not ready")).toBeTruthy();
    expect(await screen.findByTestId("card-acme-001", undefined, { timeout: 5_000 })).toBeTruthy();
    expect(calls).toBe(2);
  });

  it("shows a skeleton while the board request is in flight", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => undefined)),
    );
    render(<Board pollIntervalMs={0} now={NOW} />);
    expect(screen.getByTestId("board-skeleton")).toBeTruthy();
  });

  it("scrolls columns horizontally", async () => {
    mockBoard(
      payload({
        items: [item({ id: "acme-002", title: "Billing", status: "in-progress", priority: "p1", isReady: true })],
      }),
    );
    render(<Board pollIntervalMs={0} now={NOW} />);
    const scroller = await screen.findByTestId("board-scroller");
    expect(scroller.className).toContain("overflow-x-scroll");
    expect(scroller.className).toContain("min-w-0");
    expect(scroller.className).toContain("w-full");
    const column = screen.getByTestId("column-planned");
    expect(column.className).toContain("w-[272px]");
    expect(column.className).toContain("shrink-0");
    expect(column.className).toContain("bg-muted");
    expect(column.className).not.toContain("bg-zinc");
    expect(scroller.className).toContain("bg-background");
    const main = scroller.closest("main");
    expect(main?.className).toContain("w-full");
    expect(main?.className).toContain("min-w-0");
    expect(main?.className.includes("max-w-7xl")).toBe(false);
    expect(screen.getByRole("heading", { name: "In progress" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Snoboard" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Dark mode" })).toBeNull();
  });

  it("keeps refresh disabled until the snapshot status changes", async () => {
    const user = userEvent.setup();
    let releasePoll: (response: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      releasePoll = resolve;
    });
    let boardCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/refresh") && init?.method === "POST") {
          return jsonResponse({ accepted: true }, 202);
        }
        if (url.endsWith("/edit-config")) {
          return jsonResponse({
            enabled: false,
            modes: [],
            baseBranch: "main",
            canSubmit: false,
            needsGithubWrite: false,
            defaultMode: "pr",
          });
        }
        boardCalls += 1;
        if (boardCalls === 1) {
          return jsonResponse(
            payload({
              items: [item({ id: "acme-002", title: "Billing", status: "in-progress", priority: "p1", isReady: true })],
            }),
          );
        }
        return pending;
      }),
    );

    render(<Board pollIntervalMs={0} now={NOW} />);
    expect(await screen.findByTestId("card-acme-002")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    const refreshing = await screen.findByRole("button", { name: "Refreshing…" });
    expect((refreshing as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId("card-acme-010")).toBeNull();

    releasePoll(
      jsonResponse(
        payload({
          status: {
            lastFetchAt: "2026-09-29T14:59:00.000Z",
            lastError: null,
            lastErrorAt: null,
            refreshing: false,
          },
          items: [
            item({ id: "acme-002", title: "Billing", status: "in-progress", priority: "p1", isReady: true }),
            item({ id: "acme-010", title: "Newer", status: "planned", priority: "p1", isReady: true }),
          ],
        }),
      ),
    );
    expect(await screen.findByTestId("card-acme-010")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows a retry note when refresh is rate limited", async () => {
    const user = userEvent.setup();
    const fetchMock = mockBoard(
      payload({
        items: [item({ id: "acme-002", title: "Billing", status: "in-progress", priority: "p1", isReady: true })],
      }),
    );
    render(<Board pollIntervalMs={0} now={NOW} />);
    expect(await screen.findByTestId("card-acme-002")).toBeTruthy();
    const boardCalls = () =>
      fetchMock.mock.calls.filter((call) => String(call[0]).endsWith("/board")).length;
    const before = boardCalls();

    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/refresh") && init?.method === "POST") {
        return jsonResponse({ error: "refresh rate limited" }, 429);
      }
      return jsonResponse(payload());
    });
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Try again in a moment")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement).disabled).toBe(false);
    expect(boardCalls()).toBe(before);
    expect(screen.getByTestId("card-acme-002")).toBeTruthy();
  });

  it("keeps the last board and shows a reach error when a later fetch fails", async () => {
    const fetchMock = mockBoard(
      payload({
        items: [item({ id: "acme-002", title: "Billing", status: "in-progress", priority: "p1", isReady: true })],
      }),
    );
    render(<Board pollIntervalMs={20} now={NOW} />);
    expect(await screen.findByTestId("card-acme-002")).toBeTruthy();
    fetchMock.mockImplementation(async () => {
      throw new Error("network down");
    });
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't reach the board server: network down");
    expect(screen.getByTestId("card-acme-002")).toBeTruthy();

    fetchMock.mockImplementation(async () =>
      jsonResponse(
        payload({
          items: [item({ id: "acme-002", title: "Billing", status: "in-progress", priority: "p1", isReady: true })],
        }),
      ),
    );
    await waitFor(() => {
      expect(screen.queryByText(/Couldn't reach the board server/)).toBeNull();
    });
    expect(screen.getByTestId("card-acme-002")).toBeTruthy();
  });

  it("shows a reach error when the refresh poll cannot load the board", async () => {
    const user = userEvent.setup();
    const fetchMock = mockBoard(
      payload({
        items: [item({ id: "acme-002", title: "Billing", status: "in-progress", priority: "p1", isReady: true })],
      }),
    );
    render(<Board pollIntervalMs={0} now={NOW} refreshTimeoutMs={40} />);
    expect(await screen.findByTestId("card-acme-002")).toBeTruthy();
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/refresh") && init?.method === "POST") {
        return jsonResponse({ accepted: true }, 202);
      }
      throw new Error("network down");
    });
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Couldn't reach the board server: network down")).toBeTruthy();
    expect(screen.getByTestId("card-acme-002")).toBeTruthy();
    expect((await screen.findByRole("button", { name: "Refresh" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("redirects to login when the board returns 401", async () => {
    mockBoard({ error: "authentication required" }, 401);
    render(<Board pollIntervalMs={0} now={NOW} />);
    await waitFor(() => {
      expect(window.location.pathname).toBe("/login");
    });
  });

  it("redirects to login when a later board fetch returns 401", async () => {
    const fetchMock = mockBoard(
      payload({
        items: [item({ id: "acme-002", title: "Billing", status: "in-progress", priority: "p1", isReady: true })],
      }),
    );
    render(<Board pollIntervalMs={20} now={NOW} />);
    expect(await screen.findByTestId("card-acme-002")).toBeTruthy();
    fetchMock.mockImplementation(async () => jsonResponse({ error: "authentication required" }, 401));
    await waitFor(() => {
      expect(window.location.pathname).toBe("/login");
    });
    expect(screen.getByTestId("card-acme-002")).toBeTruthy();
  });

  it("advances relative time and the done window on the 30s clock and on data updates", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(NOW);
    const fetchMock = mockBoard(
      payload({
        items: [item({ id: "acme-001", title: "Edge done", status: "done", priority: "p1", updated: "2026-09-15", updatedAt: "2026-09-15T00:00:00.000Z" })],
      }),
    );
    render(<Board pollIntervalMs={0} />);
    expect(await screen.findByText(/5 minutes ago/)).toBeTruthy();
    expect(screen.getByTestId("card-acme-001")).toBeTruthy();

    await act(async () => {
      vi.setSystemTime(NOW + 90_000);
      await vi.advanceTimersByTimeAsync(29_000);
    });
    expect(screen.getByText(/5 minutes ago/)).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByText(/7 minutes ago/)).toBeTruthy();

    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/refresh") && init?.method === "POST") {
        return jsonResponse({ accepted: true }, 202);
      }
      return jsonResponse(
        payload({
          status: {
            lastFetchAt: "2026-09-29T14:55:00.000Z",
            lastError: "Remote fetch failed",
            lastErrorAt: "2026-09-29T14:56:00.000Z",
            refreshing: false,
          },
          items: [item({ id: "acme-001", title: "Edge done", status: "done", priority: "p1", updated: "2026-09-15", updatedAt: "2026-09-15T00:00:00.000Z" })],
        }),
      );
    });
    vi.setSystemTime(NOW + 180_000);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Remote fetch failed")).toBeTruthy();
    expect(screen.getByText(/8 minutes ago/)).toBeTruthy();

    await act(async () => {
      vi.setSystemTime(Date.parse("2026-09-30T15:00:00.000Z"));
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.queryByTestId("card-acme-001")).toBeNull();
  });
});
