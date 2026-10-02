// @vitest-environment jsdom

import { cleanup, render, renderHook, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Edit } from "snoboard/browser";
import { BasketPanel } from "@/features/basket/BasketPanel";
import { SubmitDialog } from "@/features/basket/SubmitDialog";
import { insertEditsBefore, resetBasketStore, useBasket } from "@/features/basket/store";
import { quickFixFor, readableError, resetValidationStore } from "@/features/basket/validation";

const PHASE_ERROR = 'acme-002: phases: phase 3 has status "in-progress" while the initiative is done';
const OK_A: Edit = { kind: "setStatus", id: "acme-001", from: "idea", to: "planned" };
const DONE: Edit = { kind: "setStatus", id: "acme-002", from: "in-progress", to: "done" };
const OK_B: Edit = { kind: "setPriority", id: "acme-003", from: "p2", to: "p1" };

afterEach(() => {
  cleanup();
  localStorage.clear();
  resetBasketStore();
  resetValidationStore();
  vi.unstubAllGlobals();
});

describe("readable validation errors", () => {
  it("drops the id and field prefix and ends with a full stop", () => {
    expect(readableError(PHASE_ERROR)).toBe('Phase 3 has status "in-progress" while the initiative is done.');
    expect(readableError("acme-001: stale")).toContain("changed since this edit was made");
    expect(readableError(undefined)).toBe("This edit is invalid.");
  });

  it("offers marking open phases done only for the phase error on a status edit", () => {
    const fix = quickFixFor(DONE, `${PHASE_ERROR}; phases: phase 4 has status "review" while the initiative is done`);
    expect(fix?.label).toBe("Also mark open phases done");
    expect(fix?.edits).toEqual([
      { kind: "setPhaseStatus", id: "acme-002", phase: 3, from: "in-progress", to: "done" },
      { kind: "setPhaseStatus", id: "acme-002", phase: 4, from: "review", to: "done" },
    ]);
    expect(quickFixFor(DONE, "acme-002: stale")).toBeUndefined();
    expect(quickFixFor(OK_B, PHASE_ERROR)).toBeUndefined();
  });

  it("inserts fix edits before the failing edit and replaces a queued edit for the same phase", () => {
    const queued: Edit = { kind: "setPhaseStatus", id: "acme-002", phase: 3, from: "planned", to: "in-progress" };
    const next = insertEditsBefore([OK_A, DONE, queued], 1, [
      { kind: "setPhaseStatus", id: "acme-002", phase: 3, from: "in-progress", to: "done" },
    ]);
    expect(next).toEqual([OK_A, { kind: "setPhaseStatus", id: "acme-002", phase: 3, from: "planned", to: "done" }, DONE]);
  });
});

describe("submit dialog with invalid edits", () => {
  it("summarises, explains each failure, and submits only the valid edits", async () => {
    const user = userEvent.setup();
    const basket = queue([OK_A, DONE, OK_B]);
    const submits: unknown[] = [];
    installFetch(async (url, init) => {
      if (url.endsWith("/edit-config")) return config();
      if (url.endsWith("/edits/validate")) {
        return json({ results: [{ index: 0, ok: true }, { index: 1, ok: false, error: PHASE_ERROR }, { index: 2, ok: true }] });
      }
      if (url.endsWith("/edits/submit")) {
        submits.push(JSON.parse(String(init?.body)));
        return json({ ok: true, mode: "direct", commit: "abc1234", branch: "main" });
      }
      return json({ error: "not found" }, 404);
    });

    render(<SubmitDialog />);
    await user.click(screen.getByRole("button", { name: "Submit" }));
    const dialog = await screen.findByRole("dialog");
    expect((await within(dialog).findByTestId("validate-summary")).textContent).toBe("1 of 3 edits needs attention");
    expect(within(dialog).getByTestId("validate-error").textContent).toBe(
      'Phase 3 has status "in-progress" while the initiative is done.',
    );
    expect(within(dialog).queryByRole("button", { name: "Submit edits" })).toBeNull();
    expect(within(dialog).getByTestId("submit-partial-note").textContent).toContain("stays in the basket");

    await user.click(within(dialog).getByRole("button", { name: "Submit the 2 valid edits" }));
    expect(await within(dialog).findByTestId("submit-remaining")).toBeTruthy();
    expect(submits[0]).toMatchObject({ edits: [OK_A, OK_B] });
    expect(basket.result.current.list()).toEqual([DONE]);
  });

  it("removes a failing edit and checks the basket again", async () => {
    const user = userEvent.setup();
    const basket = queue([OK_A, DONE]);
    const validated: unknown[] = [];
    installFetch(async (url, init) => {
      if (url.endsWith("/edit-config")) return config();
      if (url.endsWith("/edits/validate")) {
        const body = JSON.parse(String(init?.body)) as { edits: Edit[] };
        validated.push(body.edits);
        return json({
          results: body.edits.map((edit, index) =>
            edit.kind === "setStatus" && edit.to === "done" ? { index, ok: false, error: PHASE_ERROR } : { index, ok: true },
          ),
        });
      }
      return json({ error: "not found" }, 404);
    });

    render(<SubmitDialog />);
    await user.click(screen.getByRole("button", { name: "Submit" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByTestId("validate-error");
    const failing = within(dialog)
      .getAllByTestId("validate-result")
      .find((row) => row.getAttribute("data-valid") === "false")!;
    await user.click(within(failing).getByRole("button", { name: /^Remove / }));

    expect((await within(dialog).findByTestId("validate-summary")).textContent).toBe("The edit is valid");
    expect(basket.result.current.list()).toEqual([OK_A]);
    expect(validated).toEqual([[OK_A, DONE], [OK_A]]);
    expect(within(dialog).getByRole("button", { name: "Submit edits" })).toHaveProperty("disabled", false);
    expect(within(dialog).queryByTestId("submit-blocked")).toBeNull();
  });

  it("queues setPhaseStatus edits for open phases before the status edit", async () => {
    const user = userEvent.setup();
    const basket = queue([DONE]);
    installFetch(async (url, init) => {
      if (url.endsWith("/edit-config")) return config();
      if (url.endsWith("/edits/validate")) {
        const body = JSON.parse(String(init?.body)) as { edits: Edit[] };
        const fixed = body.edits.some((edit) => edit.kind === "setPhaseStatus");
        return json({
          results: body.edits.map((_, index) => (fixed ? { index, ok: true } : { index, ok: false, error: PHASE_ERROR })),
        });
      }
      return json({ error: "not found" }, 404);
    });

    render(<SubmitDialog />);
    await user.click(screen.getByRole("button", { name: "Submit" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(await within(dialog).findByRole("button", { name: "Also mark the open phase done" }));

    expect((await within(dialog).findByTestId("validate-summary")).textContent).toBe("All 2 edits are valid");
    expect(basket.result.current.list()).toEqual([
      { kind: "setPhaseStatus", id: "acme-002", phase: 3, from: "in-progress", to: "done" },
      DONE,
    ]);
  });
});

describe("basket panel after a validate", () => {
  it("badges the failing rows until the basket changes", async () => {
    const user = userEvent.setup();
    const basket = queue([OK_A, DONE]);
    installFetch(async (url) => {
      if (url.endsWith("/edit-config")) return config();
      if (url.endsWith("/edits/validate")) {
        return json({ results: [{ index: 0, ok: true }, { index: 1, ok: false, error: PHASE_ERROR }] });
      }
      return json({ error: "not found" }, 404);
    });

    render(<BasketPanel enabled canSubmit />);
    expect(screen.queryByTestId("basket-invalid")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Submit" }));
    await screen.findByTestId("validate-summary");
    await user.keyboard("{Escape}");

    const badges = await screen.findAllByTestId("basket-invalid");
    expect(badges).toHaveLength(1);
    expect(badges[0]!.getAttribute("aria-label")).toContain("Phase 3");
    expect(screen.getByTestId("basket-invalid-count").textContent).toBe("1 needs attention");

    act(() => {
      basket.result.current.add(OK_B);
    });
    expect(screen.queryByTestId("basket-invalid")).toBeNull();
  });
});

function queue(edits: Edit[]) {
  const basket = renderHook(() => useBasket());
  act(() => {
    for (const edit of edits) basket.result.current.add(edit);
  });
  return basket;
}

function config(): Response {
  return json({
    enabled: true,
    canSubmit: true,
    needsGithubWrite: false,
    modes: ["direct"],
    defaultMode: "direct",
    csrf: "csrf-token",
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function installFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init)),
  );
}
