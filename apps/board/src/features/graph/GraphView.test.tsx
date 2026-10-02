// @vitest-environment jsdom

import { useState, type ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageActionsProvider } from "@/components/page-actions";
import { browserLocation } from "@/features/board/sync";
import GraphView from "@/features/graph/GraphView";

vi.mock("@xyflow/react", () => ({
  ReactFlow: ({ children }: { children?: ReactNode }) => <div data-testid="flow">{children}</div>,
  Background: () => null,
  Panel: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Handle: () => null,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
  useReactFlow: () => ({
    fitView: () => Promise.resolve(true),
    zoomIn: () => undefined,
    zoomOut: () => undefined,
    zoomTo: () => Promise.resolve(true),
    getNodes: () => [],
    setNodes: () => undefined,
  }),
  useViewport: () => ({ x: 0, y: 0, zoom: 1 }),
  useStore: (selector: (state: { minZoom: number; maxZoom: number }) => unknown) =>
    selector({ minZoom: 0.02, maxZoom: 2 }),
}));

const quiet = {
  lastFetchAt: "2026-09-29T14:55:00.000Z",
  lastError: null,
  lastErrorAt: null,
  refreshing: false,
};

function board(status = quiet) {
  return {
    status,
    config: {
      statuses: ["planned", "in-progress", "done"],
      priorities: ["p1"],
      doneStatuses: ["done"],
    },
    items: [
      {
        id: "acme-002",
        title: "Billing",
        status: "in-progress",
        priority: "p1",
        depends_on: [],
        updated: "2026-09-29",
        path: "initiatives/acme/acme-002/initiative.md",
        project: "acme",
        number: "002",
        summary: "",
        sourceRef: "main",
        sourceSha: "abc",
        updatedAt: "2026-09-29T00:00:00.000Z",
        isReady: true,
        blockedBy: [],
        onBranches: ["main"],
      },
    ],
    legacy: [],
    errors: [],
    refs: [{ name: "main", sha: "abc", isDefault: true }],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function Harness({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <PageActionsProvider element={slot}>
      <div ref={setSlot} />
      {children}
    </PageActionsProvider>
  );
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
  window.history.replaceState(null, "", "/");
});

describe("graph refresh", () => {
  it("polls after refresh and keeps the graph when a later fetch fails", async () => {
    const user = userEvent.setup();
    let releasePoll: ((response: Response) => void) | undefined;
    let boardCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/refresh") && init?.method === "POST") {
          return jsonResponse({ accepted: true }, 202);
        }
        boardCalls += 1;
        if (boardCalls === 1) return jsonResponse(board());
        if (boardCalls === 2) {
          return new Promise<Response>((resolve) => {
            releasePoll = resolve;
          });
        }
        throw new Error("network down");
      }),
    );

    render(
      <Harness>
        <GraphView refreshTimeoutMs={40} />
      </Harness>,
    );
    expect(await screen.findByLabelText("Dependency graph")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect((await screen.findByRole("button", { name: "Refreshing…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByLabelText("Dependency graph")).toBeTruthy();
    await vi.waitFor(() => {
      expect(releasePoll).toBeTypeOf("function");
    });

    releasePoll?.(jsonResponse(board({ ...quiet, lastFetchAt: "2026-09-29T14:59:00.000Z" })));
    expect((await screen.findByRole("button", { name: "Refresh" }) as HTMLButtonElement).disabled).toBe(false);

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Couldn't reach the board server: network down")).toBeTruthy();
    expect(screen.getByLabelText("Dependency graph")).toBeTruthy();
  });

  it("redirects to login when the graph board fetch returns 401", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "authentication required" }, 401)));
    render(
      <Harness>
        <GraphView />
      </Harness>,
    );
    await vi.waitFor(() => {
      expect(window.location.pathname).toBe("/login");
    });
  });
});
