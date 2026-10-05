// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import type { BoardItem } from "snoboard/browser";
import { afterEach, describe, expect, it } from "vitest";
import { BoardCard } from "@/features/board/Card";
import { ProjectOption } from "@/features/board/Filters";
import { projectOptionText } from "@/features/basket/NewInitiativeDialog";
import { RepoProvider } from "@/features/repo/context";
import { iconUrl, LabelChip, openCountsByProject, publishDisplay, readDisplay, resetDisplay, resolveIconValue } from "./display";

function item(partial: Partial<BoardItem> = {}): BoardItem {
  return {
    id: "acme-002",
    title: "Billing",
    status: "in-progress",
    priority: "p1",
    depends_on: [],
    updated: "2026-09-29",
    path: "initiatives/acme/002-billing/initiative.md",
    project: "acme",
    number: "002",
    summary: "",
    sourceRef: "main",
    sourceSha: "abc",
    updatedAt: "2026-09-29T00:00:00.000Z",
    isReady: true,
    blockedBy: [],
    onBranches: ["main"],
    ...partial,
  };
}

function card(value: BoardItem) {
  return render(
    <RepoProvider repoId="team">
      <BoardCard item={value} doneStatuses={["done"]} defaultBranch="main" />
    </RepoProvider>,
  );
}

afterEach(() => {
  cleanup();
  act(() => resetDisplay());
});

describe("icon fallback chain", () => {
  it("prefers the initiative icon, then the project icon, then nothing", () => {
    const projects = { acme: { icon: "🧩" } };
    expect(resolveIconValue({ icon: "🚀", project: "acme" }, projects)).toBe("🚀");
    expect(resolveIconValue({ project: "acme" }, projects)).toBe("🧩");
    expect(resolveIconValue({ icon: "bad value", project: "acme" }, projects)).toBe("🧩");
    expect(resolveIconValue({ project: "other" }, projects)).toBeUndefined();
  });

  it("shows the icon before the id on a card", () => {
    act(() => publishDisplay("team", readDisplay({ projects: { acme: { icon: "🧩", name: "Acme" } } })));
    card(item());
    expect(screen.getByTestId("card-icon-acme-002").textContent).toBe("🧩");
    expect(screen.getByText("Acme")).toBeTruthy();
    cleanup();
    card(item({ icon: "🚀" }));
    expect(screen.getByTestId("card-icon-acme-002").textContent).toBe("🚀");
    cleanup();
    act(() => resetDisplay());
    card(item());
    expect(screen.queryByTestId("card-icon-acme-002")).toBeNull();
  });

  it("loads image icons through the authenticated icon endpoint as an img", () => {
    act(() => publishDisplay("team", readDisplay({ projects: { acme: { icon: "apps/web/public/favicon.svg" } } })));
    card(item());
    const image = screen.getByTestId("card-icon-acme-002");
    expect(image.tagName).toBe("IMG");
    expect(image.getAttribute("src")).toBe("/api/repos/team/icons/apps%2Fweb%2Fpublic%2Ffavicon.svg");
    expect(iconUrl("team", "a/b.png")).toBe("/api/repos/team/icons/a%2Fb.png");
  });

  it("drops malformed display settings", () => {
    expect(
      readDisplay({
        projects: { a: { icon: "../x.png", name: "A" }, b: "nope" },
        labels: { l: { icon: "x.png", color: "chartreuse" }, m: { icon: "💳", color: "green" } },
      }),
    ).toEqual({ projects: { a: { name: "A" }, b: {} }, labels: { l: {}, m: { icon: "💳", color: "green" } } });
    expect(readDisplay(null)).toEqual({ projects: {}, labels: {} });
  });
});

describe("label chips", () => {
  it("show the configured emoji and colour", () => {
    act(() => publishDisplay("team", readDisplay({ labels: { billing: { icon: "💳", color: "green" } } })));
    render(
      <RepoProvider repoId="team">
        <LabelChip label="billing" />
        <LabelChip label="plain" />
      </RepoProvider>,
    );
    const chip = screen.getByTestId("label-billing");
    expect(chip.textContent).toBe("💳billing");
    expect(chip.className).toContain("bg-green-500/10");
    expect(screen.getByTestId("label-plain").className).not.toContain("green");
  });
});

describe("open counts per project", () => {
  it("counts items that are not done, parked or dropped, and lists projects with none open", () => {
    const counts = openCountsByProject(
      [
        { project: "acme", status: "idea" },
        { project: "acme", status: "in-progress" },
        { project: "acme", status: "done" },
        { project: "acme", status: "parked" },
        { project: "ops", status: "dropped" },
        { project: "ops", status: "shipped" },
      ],
      ["done", "shipped"],
      ["acme", "ops", "empty"],
    );
    expect(Object.fromEntries(counts)).toEqual({ acme: 2, ops: 0, empty: 0 });
  });

  it("shows the icon, name and count in the project filter and the new-initiative picker", () => {
    const display = readDisplay({ projects: { acme: { icon: "🧩" }, ops: { icon: "ops/logo.svg", name: "Ops" } } });
    act(() => publishDisplay("team", display));
    render(
      <RepoProvider repoId="team">
        <ProjectOption project="acme" count={4} />
        <ProjectOption project="ops" name="Ops" count={0} />
      </RepoProvider>,
    );
    expect(screen.getByTestId("open-count-acme").textContent).toBe("4, 4 open");
    expect(screen.getByTestId("open-count-ops").className).toContain("text-muted-foreground/60");
    expect(projectOptionText("acme", display, 4)).toBe("🧩 acme (4 open)");
    expect(projectOptionText("ops", display, 0)).toBe("Ops (0 open)");
    expect(projectOptionText("new", display, undefined)).toBe("new");
  });
});
