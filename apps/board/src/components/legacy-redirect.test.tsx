// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserLocation } from "@/features/board/sync";
import { LegacyRedirect } from "./legacy-redirect";

const repos = [
  { id: "acme", name: "Acme platform" },
  { id: "widgets", name: "Widgets" },
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

function reposResponse(): Response {
  return new Response(JSON.stringify(repos), { status: 200, headers: { "content-type": "application/json" } });
}

describe("legacy redirect", () => {
  it("sends an unqualified initiative bookmark to the first repo, not the remembered one", async () => {
    localStorage.setItem("snoboard:last-repo:v1", "widgets");
    window.history.replaceState(null, "", "/initiatives/acme-002");
    vi.stubGlobal("fetch", vi.fn(async () => reposResponse()));
    const replace = vi.spyOn(browserLocation, "replace").mockImplementation(() => {});
    render(<LegacyRedirect />);
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/r/acme/initiatives/acme-002"));
  });

  it("sends / to the remembered repo", async () => {
    localStorage.setItem("snoboard:last-repo:v1", "widgets");
    vi.stubGlobal("fetch", vi.fn(async () => reposResponse()));
    const replace = vi.spyOn(browserLocation, "replace").mockImplementation(() => {});
    render(<LegacyRedirect />);
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/r/widgets/"));
  });

  it("shows a retry instead of guessing a repo when the repository list fails", async () => {
    const fetchMock = vi.fn(async () => new Response("down", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);
    const replace = vi.spyOn(browserLocation, "replace").mockImplementation(() => {});
    render(<LegacyRedirect />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();

    fetchMock.mockImplementation(async () => reposResponse());
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }));
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/r/acme/"));
  });
});
