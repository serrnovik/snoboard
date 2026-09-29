// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardPayload } from "@/features/board/model";
import {
  browserLocation,
  pollBoardUntilChange,
  reachErrorMessage,
  REFRESH_POLL_MAX_MS,
  REFRESH_POLL_MS,
} from "@/features/board/sync";

function payload(status: BoardPayload["status"]): BoardPayload {
  return {
    status,
    config: {
      statuses: ["planned", "done"],
      priorities: ["p1"],
      doneStatuses: ["done"],
    },
    items: [],
    legacy: [],
    errors: [],
    refs: [],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const quiet = {
  lastFetchAt: "2026-09-29T14:55:00.000Z",
  lastError: null,
  lastErrorAt: null,
  refreshing: false,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("board refresh polling", () => {
  it("polls once a second until status changes, and gives up after 60 seconds", async () => {
    expect(REFRESH_POLL_MS).toBe(1_000);
    expect(REFRESH_POLL_MAX_MS).toBe(60_000);
    const sleeps: number[] = [];
    let clock = 0;
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return jsonResponse(payload(quiet));
      }),
    );

    const result = await pollBoardUntilChange(
      { lastFetchAt: quiet.lastFetchAt, lastError: quiet.lastError },
      {
        now: () => clock,
        sleep: async (ms) => {
          sleeps.push(ms);
          clock += ms;
        },
      },
    );

    expect(result.kind).toBe("timeout");
    expect(calls).toBe(60);
    expect(sleeps).toEqual(Array.from({ length: 60 }, () => 1_000));
    expect(clock).toBe(60_000);
  });

  it("stops when lastFetchAt or lastError changes", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls < 3) return jsonResponse(payload(quiet));
        return jsonResponse(
          payload({
            ...quiet,
            lastFetchAt: "2026-09-29T14:59:00.000Z",
            lastError: "Remote fetch failed",
          }),
        );
      }),
    );

    const result = await pollBoardUntilChange(
      { lastFetchAt: quiet.lastFetchAt, lastError: null },
      {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        now: () => sleeps.length * 1_000,
      },
    );

    expect(result.kind).toBe("updated");
    if (result.kind === "updated") {
      expect(result.payload.status.lastFetchAt).toBe("2026-09-29T14:59:00.000Z");
      expect(result.payload.status.lastError).toBe("Remote fetch failed");
    }
    expect(calls).toBe(3);
    expect(sleeps).toEqual([1_000, 1_000]);
  });

  it("reports a failed poll and redirects on 401", async () => {
    vi.spyOn(browserLocation, "assign").mockImplementation((path: string) => {
      window.history.replaceState(null, "", path);
    });
    const failures: string[] = [];
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) return jsonResponse({ error: "snapshot not ready" }, 503);
        return jsonResponse({ error: "authentication required" }, 401);
      }),
    );

    let clock = 0;
    const result = await pollBoardUntilChange(
      { lastFetchAt: quiet.lastFetchAt, lastError: null },
      {
        timeoutMs: 5_000,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        onFailure: (message) => failures.push(message),
      },
    );

    expect(failures).toEqual(["snapshot not ready"]);
    expect(reachErrorMessage(failures[0] ?? "")).toBe("Couldn't reach the board server: snapshot not ready");
    expect(result.kind).toBe("unauthorized");
    expect(window.location.pathname).toBe("/login");
  });
});
