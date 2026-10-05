// @vitest-environment jsdom

import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { submitNavigation } from "@/features/basket/SubmitDialog";
import { resetBasketStore, useBasket } from "@/features/basket/store";
import { parseEditConfig } from "@/features/basket/edit-config";
import { IssuesEditor } from "@/features/details/ListEditors";
import {
  defaultIssueBody,
  ISSUE_RESUME_KEY,
  issueDraftProblem,
  takeIssueResume,
} from "@/features/issues/NewIssueDialog";

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  resetBasketStore();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const create = { providers: ["fj", "vikunja"] as const, csrf: "csrf-1", title: "Faster sync", summary: "Make sync fast." };

describe("new issue dialog", () => {
  it("is hidden without trackers and lists only enabled ones", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<IssuesEditor id="acme-002" issues={[]} create={{ ...create, providers: [] }} />);
    expect(screen.queryByRole("button", { name: "New issue" })).toBeNull();
    rerender(<IssuesEditor id="acme-002" issues={[]} create={{ ...create, providers: ["fj", "vikunja"] }} />);
    await user.click(screen.getByRole("button", { name: "New issue" }));
    const select = screen.getByRole("combobox", { name: "Tracker" }) as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(["fj", "vikunja"]);
    expect((screen.getByRole("textbox", { name: "Title" }) as HTMLInputElement).value).toBe("Faster sync: ");
  });

  it("creates the issue, adds a pending setIssues edit and shows the chip with its link", async () => {
    const user = userEvent.setup();
    const basket = renderHook(() => useBasket());
    const fetchSpy = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ ok: true, ref: "fj#5", url: "https://forge.example.com/acme/widgets/issues/5" }, 201),
    );
    vi.stubGlobal("fetch", fetchSpy);
    render(<IssuesEditor id="acme-002" issues={[{ raw: "gh#1", url: "", title: "", state: "unknown" }]} create={{ ...create, providers: ["fj", "vikunja"] }} />);
    await user.click(screen.getByRole("button", { name: "New issue" }));
    const title = screen.getByRole("textbox", { name: "Title" });
    await user.type(title, "first step");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(screen.getByTestId("issue-created").textContent).toContain("fj#5"));
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(String(url)).toBe("/api/repos/default/issues/create");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      provider: "fj",
      initiativeId: "acme-002",
      title: "Faster sync: first step",
      csrf: "csrf-1",
    });
    expect(JSON.parse(String(init?.body)).body).toContain("Make sync fast.");
    expect(basket.result.current.list()).toEqual([{ kind: "setIssues", id: "acme-002", from: ["gh#1"], to: ["gh#1", "fj#5"] }]);
    const chips = screen.getAllByTestId("issue-chip");
    expect(chips).toHaveLength(2);
    expect(chips[1]?.querySelector("a")?.getAttribute("href")).toBe("https://forge.example.com/acme/widgets/issues/5");
    expect(screen.getByTestId("issue-created").querySelector("a")?.getAttribute("href")).toBe(
      "https://forge.example.com/acme/widgets/issues/5",
    );
  });

  it("shows the server error and keeps the dialog open", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: false, code: "scope", error: "Forgejo token lacks issue write scope" }, 403)));
    render(<IssuesEditor id="acme-002" issues={[]} create={{ ...create, providers: ["fj"] }} />);
    await user.click(screen.getByRole("button", { name: "New issue" }));
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("lacks issue write scope"));
    expect(screen.getByTestId("new-issue-dialog")).toBeTruthy();
  });

  it("connects GitHub when needed and resumes the draft afterwards", async () => {
    const user = userEvent.setup();
    const assign = vi.spyOn(submitNavigation, "assign").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: false, code: "needs_github_write", needsGithubWrite: true }, 401)));
    render(<IssuesEditor id="acme-002" issues={[]} create={{ ...create, providers: ["gh"] }} />);
    await user.click(screen.getByRole("button", { name: "New issue" }));
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(String(assign.mock.calls[0]?.[0])).toContain("/auth/github/write?repo=default&return=");
    expect(decodeURIComponent(String(assign.mock.calls[0]?.[0]))).toContain("resumeIssue=1");
    expect(sessionStorage.getItem(ISSUE_RESUME_KEY)).toContain("acme-002");
    cleanup();

    // Back from GitHub: the same draft is created automatically.
    window.history.replaceState(null, "", "/?open=acme-002&resumeIssue=1");
    const fetchSpy = vi.fn(async () => jsonResponse({ ok: true, ref: "gh#9", url: "https://github.com/acme/board/issues/9" }, 201));
    vi.stubGlobal("fetch", fetchSpy);
    const basket = renderHook(() => useBasket());
    render(<IssuesEditor id="acme-002" issues={[]} create={{ ...create, providers: ["gh"] }} />);
    await waitFor(() => expect(screen.getByTestId("issue-created").textContent).toContain("gh#9"));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe("?open=acme-002");
    expect(basket.result.current.list()).toEqual([{ kind: "setIssues", id: "acme-002", from: [], to: ["gh#9"] }]);
    expect(sessionStorage.getItem(ISSUE_RESUME_KEY)).toBeNull();
  });

  it("validates drafts and ignores stale or foreign resume drafts", () => {
    expect(issueDraftProblem({ title: " ", body: "" })).toMatch(/required/);
    expect(issueDraftProblem({ title: "x".repeat(257), body: "" })).toMatch(/256/);
    expect(issueDraftProblem({ title: "ok", body: "x".repeat(20_001) })).toMatch(/20000/);
    expect(defaultIssueBody("https://board.example.com/r/a/initiatives/a-001", "")).toBe(
      "Initiative on the board: https://board.example.com/r/a/initiatives/a-001\n",
    );
    sessionStorage.setItem(ISSUE_RESUME_KEY, JSON.stringify({ repoId: "default", initiativeId: "a-001", provider: "gh", title: "t", body: "b", at: 0 }));
    expect(takeIssueResume("default", "a-001", 60 * 60 * 1000)).toBeNull();
    sessionStorage.setItem(ISSUE_RESUME_KEY, JSON.stringify({ repoId: "other", initiativeId: "a-001", provider: "gh", title: "t", body: "b", at: 0 }));
    expect(takeIssueResume("default", "a-001", 0)).toBeNull();
  });

  it("reads createProviders from edit-config", () => {
    expect(parseEditConfig({ createProviders: ["gh", "jira", "fj", "fj"] }).createProviders).toEqual(["gh", "fj"]);
    expect(parseEditConfig({}).createProviders).toBeUndefined();
  });

  it("preselects the mapped Vikunja project and sends the chosen one", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn(async (url: string | URL | Request, _init?: RequestInit) =>
      String(url).includes("vikunja-projects")
        ? jsonResponse({ projects: [{ id: 9, title: "Productivity" }, { id: 23, title: "App" }], selected: 23 })
        : jsonResponse({ ok: true, ref: "vj:5", url: "https://tasks.example.com/tasks/5" }, 201),
    );
    vi.stubGlobal("fetch", fetchSpy);
    render(<IssuesEditor id="acme-002" issues={[]} create={{ ...create, providers: ["vikunja"] }} />);
    await user.click(screen.getByRole("button", { name: "New issue" }));
    const project = (await screen.findByRole("combobox", { name: "Vikunja project" })) as HTMLSelectElement;
    await waitFor(() => expect(project.value).toBe("23"));
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("/api/repos/default/issues/vikunja-projects?initiative=acme-002");
    await user.selectOptions(project, "9");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.getByTestId("issue-created").textContent).toContain("vj:5"));
    expect(JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body))).toMatchObject({ provider: "vikunja", projectId: 9 });
  });
});
