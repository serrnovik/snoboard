// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderHook } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  rememberedSubmitMode,
  SubmitDialog,
  submitModeStorageKey,
} from "@/features/basket/SubmitDialog";
import { resetBasketStore, useBasket } from "@/features/basket/store";

const EDIT = { kind: "setStatus" as const, id: "acme-001", from: "idea", to: "planned" };

afterEach(() => {
  cleanup();
  localStorage.clear();
  resetBasketStore();
  vi.unstubAllGlobals();
});

describe("submit dialog", () => {
  it("defaults to direct, validates, then shows the pull request link and clears the basket", async () => {
    const user = userEvent.setup();
    const basket = renderHook(() => useBasket());
    act(() => {
      basket.result.current.add(EDIT);
    });
    const calls: { url: string; body?: unknown }[] = [];
    installFetch(async (url, init) => {
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ url, body });
      if (url.endsWith("/edit-config")) return configBody({ defaultMode: "direct", modes: ["direct", "pr"] });
      if (url.endsWith("/edits/validate")) return json({ results: [{ index: 0, ok: true }] });
      if (url.endsWith("/edits/submit")) {
        return json({
          ok: true,
          mode: "pr",
          commit: "abc1234fff",
          branch: "snoboard/edits-20261001-120000-ab12",
          pr: { number: 7, url: "https://github.com/acme/board/pull/7" },
        });
      }
      return json({ error: "not found" }, 404);
    });

    render(<SubmitDialog titles={new Map([["acme-001", "Gantt export"]])} />);
    await user.click(screen.getByRole("button", { name: "Submit" }));
    const dialog = await screen.findByRole("dialog");
    const result = await within(dialog).findByTestId("validate-result");
    expect(result).toBeTruthy();
    expect((result.textContent ?? "").replace(/\s+/g, " ").trim()).toBe("acme-001 · Gantt export — idea → planned");
    const title = within(dialog).getByTestId("edit-label-title");
    expect(title.getAttribute("title")).toBe("Gantt export");
    expect(title.className).toContain("truncate");
    const direct = within(dialog).getByRole("radio", { name: "Push to main" }) as HTMLInputElement;
    expect(direct.checked).toBe(true);
    expect(calls.some((call) => call.url.endsWith("/edits/validate"))).toBe(true);
    expect(calls.some((call) => call.url.endsWith("/edits/submit"))).toBe(false);

    await user.click(within(dialog).getByRole("radio", { name: "Open a pull request" }));
    expect(localStorage.getItem(submitModeStorageKey("default"))).toBe("pr");
    await user.click(within(dialog).getByRole("button", { name: "Submit edits" }));

    expect(await within(dialog).findByTestId("submit-pr")).toBeTruthy();
    expect(within(dialog).getByTestId("submit-pr").getAttribute("href")).toBe("https://github.com/acme/board/pull/7");
    expect(basket.result.current.list()).toEqual([]);
    const submitted = calls.find((call) => call.url.endsWith("/edits/submit"));
    expect(submitted?.url).toBe("/api/repos/default/edits/submit");
    expect(submitted?.body).toMatchObject({ edits: [EDIT], mode: "pr", csrf: "csrf-token", repo: "default" });
  });

  it("restores the last submit mode for the repository", async () => {
    const user = userEvent.setup();
    queueEdit("widgets");
    localStorage.setItem(submitModeStorageKey("widgets"), "pr");
    installFetch(async (url) => {
      if (url.endsWith("/edit-config")) {
        return configBody({ defaultMode: "direct", modes: ["direct", "pr"], directBranch: "live" });
      }
      if (url.endsWith("/edits/validate")) return json({ results: [{ index: 0, ok: true }] });
      return json({ error: "not found" }, 404);
    });

    render(<SubmitDialog repoId="widgets" />);
    await user.click(screen.getByRole("button", { name: "Submit" }));
    const dialog = await screen.findByRole("dialog");
    const pull = (await within(dialog).findByRole("radio", { name: "Open a pull request" })) as HTMLInputElement;
    expect(pull.checked).toBe(true);
    expect(rememberedSubmitMode("widgets", ["direct", "pr"], "direct")).toBe("pr");
    expect(within(dialog).getByRole("radio", { name: "Push to live" })).toBeTruthy();
  });

  it("asks to connect GitHub instead of submitting", async () => {
    const user = userEvent.setup();
    queueEdit();
    const calls: string[] = [];
    installFetch(async (url) => {
      calls.push(url);
      if (url.endsWith("/edit-config")) {
        return configBody({ defaultMode: "direct", modes: ["direct", "pr"], needsGithubWrite: true });
      }
      if (url.endsWith("/edits/validate")) return json({ results: [{ index: 0, ok: true }] });
      return json({ error: "not found" }, 404);
    });

    render(<SubmitDialog />);
    await user.click(screen.getByRole("button", { name: "Submit" }));
    const dialog = await screen.findByRole("dialog");
    const link = await within(dialog).findByRole("link", { name: "Connect GitHub" });
    expect(link.getAttribute("href")).toBe("/auth/github/write?repo=default&return=%2F");
    expect(within(dialog).queryByRole("button", { name: "Submit edits" })).toBeNull();
    expect(calls.some((url) => url.endsWith("/edits/submit"))).toBe(false);
  });

  it("keeps an invalid basket from being submitted", async () => {
    const user = userEvent.setup();
    queueEdit();
    installFetch(async (url) => {
      if (url.endsWith("/edit-config")) return configBody({ defaultMode: "direct", modes: ["direct"] });
      if (url.endsWith("/edits/validate")) {
        return json({ results: [{ index: 0, ok: false, error: "stale" }] });
      }
      return json({ error: "not found" }, 404);
    });

    render(<SubmitDialog />);
    await user.click(screen.getByRole("button", { name: "Submit" }));
    const dialog = await screen.findByRole("dialog");
    expect((await within(dialog).findByTestId("validate-error")).textContent).toContain("The initiative changed");
    const button = within(dialog).getByRole("button", { name: "Submit edits" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(within(dialog).getByTestId("submit-blocked").textContent).toContain("None of these edits can be submitted");
    expect(button.getAttribute("aria-describedby")).toBe(within(dialog).getByTestId("submit-blocked").id);
  });

  it("offers one-click pull request when a direct push is rejected", async () => {
    const user = userEvent.setup();
    const basket = renderHook(() => useBasket());
    act(() => {
      basket.result.current.add(EDIT);
    });
    const submitted: unknown[] = [];
    installFetch(async (url, init) => {
      if (url.endsWith("/edit-config")) return configBody({ defaultMode: "direct", modes: ["direct", "pr"] });
      if (url.endsWith("/edits/validate")) return json({ results: [{ index: 0, ok: true }] });
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { mode?: string }) : {};
      submitted.push(body.mode);
      if (body.mode === "direct") {
        return json(
          {
            ok: false,
            code: "direct_rejected",
            error: "GitHub refused the push to main (branch protection?). Nothing was pushed.",
            alternativeMode: "pr",
          },
          409,
        );
      }
      return json({
        ok: true,
        mode: "pr",
        commit: "abc1234fff",
        branch: "snoboard/edits-20261001-120000-ab12",
        pr: { number: 8, url: "https://github.com/acme/board/pull/8" },
      });
    });

    render(<SubmitDialog />);
    await user.click(screen.getByRole("button", { name: "Submit" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByTestId("validate-result");
    await user.click(within(dialog).getByRole("button", { name: "Submit edits" }));
    expect(await within(dialog).findByTestId("submit-error")).toBeTruthy();
    expect(within(dialog).getByTestId("submit-error").textContent).toContain("Nothing was pushed");
    expect(basket.result.current.list()).toEqual([EDIT]);

    await user.click(within(dialog).getByRole("button", { name: "Open a PR instead" }));
    expect(await within(dialog).findByTestId("submit-pr")).toBeTruthy();
    expect(submitted).toEqual(["direct", "pr"]);
    expect(basket.result.current.list()).toEqual([]);
  });

  it("shows the commit link after a direct push", async () => {
    const user = userEvent.setup();
    queueEdit();
    installFetch(async (url) => {
      if (url.endsWith("/edit-config")) return configBody({ defaultMode: "direct", modes: ["direct"] });
      if (url.endsWith("/edits/validate")) return json({ results: [{ index: 0, ok: true }] });
      return json({
        ok: true,
        mode: "direct",
        commit: "abcdef1234567890",
        branch: "main",
        commitUrl: "https://github.com/acme/board/commit/abcdef1234567890",
      });
    });

    render(<SubmitDialog />);
    await user.click(screen.getByRole("button", { name: "Submit" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("button", { name: "Submit edits" });
    await user.click(within(dialog).getByRole("button", { name: "Submit edits" }));
    const link = await within(dialog).findByTestId("submit-commit");
    expect(link.getAttribute("href")).toBe("https://github.com/acme/board/commit/abcdef1234567890");
    expect(link.textContent).toBe("Pushed abcdef1 to main");
  });

  it("lists the submitted edits with titles, links the commit from forgeRepo, and closes on Done", async () => {
    const user = userEvent.setup();
    queueEdit();
    installFetch(async (url) => {
      if (url.endsWith("/edit-config")) {
        return configBody({ defaultMode: "direct", modes: ["direct"], forgeRepo: "acme/board" });
      }
      if (url.endsWith("/edits/validate")) return json({ results: [{ index: 0, ok: true }] });
      return json({ ok: true, mode: "direct", commit: "eb021c5aaaa", branch: "main" });
    });

    render(<SubmitDialog titles={new Map([["acme-001", "Gantt export"]])} />);
    await user.click(screen.getByRole("button", { name: "Submit" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByTestId("validate-result");
    await user.click(within(dialog).getByRole("button", { name: "Submit edits" }));
    const link = await within(dialog).findByTestId("submit-commit");
    expect(link.getAttribute("href")).toBe("https://github.com/acme/board/commit/eb021c5aaaa");
    expect(link.textContent).toBe("Pushed eb021c5 to main");
    const lines = within(dialog).getAllByTestId("submitted-edit").map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim());
    expect(lines).toEqual(["acme-001 · Gantt export — idea → planned"]);
    expect(dialog.textContent).not.toContain("Edit 1");
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("submits a new initiative and shows the assigned id and path", async () => {
    const user = userEvent.setup();
    const basket = renderHook(() => useBasket());
    const create = {
      kind: "createInitiative" as const,
      project: "acme",
      slug: "gamma",
      title: "Gamma export",
      status: "idea",
      priority: "p2",
    };
    act(() => {
      basket.result.current.add(create);
    });
    installFetch(async (url) => {
      if (url.endsWith("/edit-config")) return configBody({ defaultMode: "pr", modes: ["pr"] });
      if (url.endsWith("/edits/validate")) return json({ results: [{ index: 0, ok: true, number: "003" }] });
      return json({
        ok: true,
        mode: "pr",
        commit: "abc1234fff",
        branch: "snoboard/edits-x",
        pr: { number: 12, url: "https://github.com/acme/board/pull/12" },
        created: [{ index: 0, id: "acme-003", number: "003", path: "initiatives/acme/003-gamma/initiative.md" }],
      });
    });

    render(<SubmitDialog />);
    await user.click(screen.getByRole("button", { name: "Submit" }));
    const dialog = await screen.findByRole("dialog");
    const pending = await within(dialog).findByTestId("validate-result");
    expect((pending.textContent ?? "").replace(/\s+/g, " ").trim()).toBe("acme/gamma · Gamma export — create");
    await user.click(within(dialog).getByRole("button", { name: "Submit edits" }));
    const pr = await within(dialog).findByTestId("submit-pr");
    expect(pr.textContent).toBe("Opened PR #12");
    expect(pr.getAttribute("href")).toBe("https://github.com/acme/board/pull/12");
    expect(within(dialog).getByTestId("created-initiative").textContent).toBe(
      "Created acme-003 at initiatives/acme/003-gamma/initiative.md",
    );
    expect(basket.result.current.list()).toEqual([]);
  });
});

function queueEdit(repoId = "default") {
  const basket = renderHook(() => useBasket(repoId));
  act(() => {
    basket.result.current.add(EDIT);
  });
}

function configBody(partial: {
  defaultMode: "direct" | "pr";
  modes: Array<"direct" | "pr">;
  needsGithubWrite?: boolean;
  directBranch?: string;
  forgeRepo?: string;
}): Response {
  return json({
    enabled: true,
    canSubmit: true,
    needsGithubWrite: partial.needsGithubWrite ?? false,
    modes: partial.modes,
    defaultMode: partial.defaultMode,
    csrf: "csrf-token",
    baseBranch: "main",
    ...(partial.forgeRepo === undefined ? {} : { forgeRepo: partial.forgeRepo }),
    ...(partial.directBranch === undefined ? { directBranch: "main" } : { directBranch: partial.directBranch }),
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init)),
  );
}
