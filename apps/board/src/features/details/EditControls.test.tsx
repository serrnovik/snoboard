// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import type { BoardItem } from "snoboard/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetBasketStore, useBasket } from "@/features/basket/store";
import { EditControls } from "@/features/details/EditControls";
import { renderHook } from "@testing-library/react";

// The real editor is covered in markdown-editor.test.tsx; here a textarea stands in for it.
vi.mock("@/components/markdown-editor-impl", () => ({
  default: (props: { value: string; onChange: (value: string) => void; "aria-label": string }) => (
    <textarea
      data-testid="markdown-editor"
      aria-label={props["aria-label"]}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
    />
  ),
}));

const HASH = "ab".repeat(32);

function item(overrides: Partial<BoardItem> = {}): BoardItem {
  return {
    id: "acme-002",
    title: "Billing",
    status: "in-progress",
    priority: "p1",
    depends_on: [],
    updated: "2026-09-29",
    labels: ["payments"],
    phases: [
      { id: 1, title: "Invoices", status: "planned" },
      { id: 2, title: "Receipts", status: "in-progress" },
    ],
    path: "initiatives/acme/002-billing/initiative.md",
    project: "acme",
    number: "002",
    summary: "Charge customers.",
    sourceRef: "main",
    sourceSha: "abc",
    updatedAt: "2026-09-29T00:00:00.000Z",
    isReady: true,
    blockedBy: [],
    onBranches: ["main"],
    ...overrides,
  };
}

async function settle(fetchMock: ReturnType<typeof vi.fn>): Promise<void> {
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  await act(async () => {
    await Promise.all(fetchMock.mock.results.map((result) => result.value));
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockApis(enabled: boolean) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/edit-config")) {
      return json({
        enabled,
        modes: enabled ? ["direct"] : [],
        baseBranch: "main",
        canSubmit: false,
        needsGithubWrite: false,
        defaultMode: "direct",
      });
    }
    if (url.endsWith("/board")) {
      return json({
        config: {
          statuses: ["planned", "in-progress", "review", "done"],
          priorities: ["p0", "p1", "p2", "p3"],
          doneStatuses: ["done"],
        },
      });
    }
    if (url.endsWith("/body")) return json({ body: "Hello from the initiative.\n", hash: HASH });
    return json({ error: "not found" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  resetBasketStore();
});

describe("edit controls", () => {
  it("queues every edit kind from the form", async () => {
    const user = userEvent.setup();
    mockApis(true);
    const basket = renderHook(() => useBasket());
    render(<EditControls item={item()} />);

    expect(await screen.findByTestId("edit-controls")).toBeTruthy();
    const title = screen.getByRole("textbox", { name: "Title" });
    const status = screen.getByRole("combobox", { name: "Status" });
    const priority = screen.getByRole("combobox", { name: "Priority" });
    const labels = screen.getByRole("textbox", { name: "Labels" });
    const phase = screen.getByRole("combobox", { name: "Phase 1 status" });
    title.focus();
    await user.tab();
    expect(document.activeElement).toBe(status);
    await user.tab();
    expect(document.activeElement).toBe(priority);
    await user.tab();
    expect(document.activeElement).toBe(labels);

    await user.clear(title);
    await user.type(title, "Invoices");
    title.blur();
    await user.click(status);
    await user.click(await screen.findByRole("option", { name: "review" }));
    await user.click(priority);
    await user.click(await screen.findByRole("option", { name: "p0" }));
    await user.clear(labels);
    await user.type(labels, "payments, billing");
    labels.blur();
    await user.click(phase);
    await user.click(await screen.findByRole("option", { name: "done" }));
    await user.click(screen.getByRole("button", { name: "Edit text" }));
    const editor = await screen.findByTestId("markdown-editor");
    expect(editor.getAttribute("aria-label")).toBe("Initiative text");
    await user.clear(editor);
    await user.type(editor, "Updated body");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(basket.result.current.list()).toEqual([
      { kind: "setTitle", id: "acme-002", from: "Billing", to: "Invoices" },
      { kind: "setStatus", id: "acme-002", from: "in-progress", to: "review" },
      { kind: "setPriority", id: "acme-002", from: "p1", to: "p0" },
      { kind: "setLabels", id: "acme-002", from: ["payments"], to: ["payments", "billing"] },
      { kind: "setPhaseStatus", id: "acme-002", phase: 1, from: "planned", to: "done" },
      { kind: "setBody", id: "acme-002", fromHash: HASH, to: "Updated body" },
    ]);
  });

  it("discards body text on cancel", async () => {
    const user = userEvent.setup();
    mockApis(true);
    const basket = renderHook(() => useBasket());
    render(<EditControls item={item()} />);
    await user.click(await screen.findByRole("button", { name: "Edit text" }));
    await user.type(await screen.findByRole("textbox", { name: "Initiative text" }), "Nope");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("textbox", { name: "Initiative text" })).toBeNull();
    expect(basket.result.current.list()).toEqual([]);
  });

  it("hides controls when editing is off", async () => {
    const fetchMock = mockApis(false);
    render(<EditControls item={item()} />);
    await settle(fetchMock);
    expect(screen.queryByTestId("edit-controls")).toBeNull();
  });

  it("hides controls for a legacy initiative", async () => {
    const fetchMock = mockApis(true);
    render(<EditControls item={item({ id: "notes" })} />);
    await settle(fetchMock);
    expect(screen.queryByTestId("edit-controls")).toBeNull();
  });
});

describe("icon editing", () => {
  it("queues setIcon from a suggestion and from typed text, and refuses a bad value", async () => {
    const user = userEvent.setup();
    mockApis(true);
    const basket = renderHook(() => useBasket());
    render(<EditControls item={item()} />);
    const input = await screen.findByRole("textbox", { name: "Icon" });

    await user.click(screen.getByRole("button", { name: "Use icon 🚀" }));
    await waitFor(() =>
      expect(basket.result.current.edits).toContainEqual({ kind: "setIcon", id: "acme-002", from: "", to: "🚀" }),
    );

    await user.clear(input);
    await user.type(input, "not an icon{Enter}");
    expect(screen.getByRole("alert").textContent).toMatch(/one or two emoji/);
    expect(basket.result.current.edits.filter((edit) => edit.kind === "setIcon")).toEqual([
      { kind: "setIcon", id: "acme-002", from: "", to: "🚀" },
    ]);

    await user.clear(input);
    await user.type(input, "brand/logo.svg{Enter}");
    await waitFor(() =>
      expect(basket.result.current.edits.filter((edit) => edit.kind === "setIcon")).toEqual([
        { kind: "setIcon", id: "acme-002", from: "", to: "brand/logo.svg" },
      ]),
    );
  });

  it("clears an existing icon", async () => {
    const user = userEvent.setup();
    mockApis(true);
    const basket = renderHook(() => useBasket());
    render(<EditControls item={item({ icon: "🧩" })} />);
    expect(((await screen.findByRole("textbox", { name: "Icon" })) as HTMLInputElement).value).toBe("🧩");
    await user.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() =>
      expect(basket.result.current.edits).toContainEqual({ kind: "setIcon", id: "acme-002", from: "🧩", to: "" }),
    );
  });
});
