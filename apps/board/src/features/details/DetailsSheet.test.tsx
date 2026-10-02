// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserLocation } from "@/features/board/sync";
import { DetailsSheet, InitiativePage } from "./DetailsSheet";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function details() {
  return {
    id: "acme-002",
    title: "Billing",
    summary: "Charge customers.",
    status: "in-progress",
    priority: "p1",
    depends_on: [] as string[],
    updated: "2026-09-29",
    path: "initiatives/acme/002-billing/initiative.md",
    project: "acme",
    number: "002",
    sourceRef: "main",
    sourceSha: "abc",
    updatedAt: "2026-09-29T00:00:00.000Z",
    isReady: true,
    blockedBy: [] as string[],
    onBranches: ["main"],
    blockedChain: [] as string[],
    dependents: [] as string[],
    phases: [],
  };
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

describe("initiative details", () => {
  it("redirects to login when the initiative request returns 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "authentication required" }, 401)),
    );
    render(<InitiativePage id="acme-002" />);
    await waitFor(() => {
      expect(window.location.pathname).toBe("/login");
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("authentication required")).toBeNull();
  });

  it("styles sheet resource links and adds an external icon on the GitHub ones", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(details())));
    render(<DetailsSheet openId="acme-002" onOpenChange={() => {}} />);
    const file = await screen.findByRole("link", { name: "initiative.md" });
    const folder = screen.getByRole("link", { name: "Folder" });
    const fullPage = screen.getByRole("link", { name: "Open full page" });
    for (const link of [file, folder, fullPage]) {
      expect(link.className).toContain("text-primary");
      expect(link.className).toContain("hover:underline");
    }
    expect(file.querySelector(".lucide-external-link")).toBeTruthy();
    expect(folder.querySelector(".lucide-external-link")).toBeTruthy();
    expect(fullPage.querySelector("svg")).toBeNull();
    expect(file.getAttribute("target")).toBe("_blank");
    expect(folder.getAttribute("rel")).toBe("noopener noreferrer");
    expect(fullPage.getAttribute("href")).toBe("/r/default/initiatives/acme-002");
  });

  it("lists each issue with its title, state, and link", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          ...details(),
          issues: [
            {
              raw: "gh#12",
              title: "Export",
              state: "open",
              url: "https://github.com/acme/widgets/issues/12",
            },
            {
              raw: "vikunja:9",
              title: "",
              state: "unknown",
              url: "https://tasks.example.com/tasks/9",
            },
          ],
        }),
      ),
    );
    render(<DetailsSheet openId="acme-002" onOpenChange={() => {}} />);
    const list = await screen.findByTestId("issue-list");
    const links = list.querySelectorAll("[data-testid=issue-link]");
    expect(links).toHaveLength(2);
    const open = links[0];
    const unknown = links[1];
    if (open === undefined || unknown === undefined) throw new Error("missing issue link");
    expect(open.textContent).toContain("Export");
    expect(open.textContent).toContain("open");
    expect(open.getAttribute("href")).toBe("https://github.com/acme/widgets/issues/12");
    expect(open.getAttribute("rel")).toBe("noopener noreferrer");
    expect(unknown.getAttribute("data-state")).toBe("unknown");
    expect(unknown.getAttribute("href")).toBe("https://tasks.example.com/tasks/9");
    expect(unknown.getAttribute("rel")).toBe("noopener noreferrer");
    expect(unknown.className).not.toContain("destructive");
    expect(list.querySelector("[role=alert]")).toBeNull();
  });

  it("shows external links in a Links section, only https and mailto, opening in a new tab", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          ...details(),
          summary: "See ![diagram](assets/flow.png) and ![x](https://tracker.example/pixel.gif)",
          links: [
            { title: "Design doc", url: "https://docs.example.com/design" },
            { title: "Team", url: "mailto:team@example.com" },
            { title: "Evil", url: "javascript:alert(1)" },
            { title: "Plain", url: "http://example.com" },
          ],
        }),
      ),
    );
    render(<DetailsSheet openId="acme-002" onOpenChange={() => {}} />);
    const section = await screen.findByTestId("external-links");
    const anchors = [...section.querySelectorAll("a")];
    expect(anchors.map((anchor) => anchor.textContent)).toEqual(["Design doc", "Team"]);
    for (const anchor of anchors) {
      expect(anchor.getAttribute("rel")).toBe("noopener noreferrer");
      expect(anchor.getAttribute("target")).toBe("_blank");
      expect(anchor.querySelector("svg")).not.toBeNull();
    }
    const images = [...document.querySelectorAll("[data-testid=details-sheet] img")].map((img) => img.getAttribute("src"));
    expect(images).toEqual(["/api/repos/default/initiatives/acme-002/assets/flow.png"]);
  });
});
