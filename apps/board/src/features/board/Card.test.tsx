// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { BoardItem } from "snoboard/browser";
import { afterEach, describe, expect, it } from "vitest";
import { BoardCard } from "@/features/board/Card";

function item(): BoardItem {
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
  };
}

afterEach(() => {
  cleanup();
});

describe("proposed badge", () => {
  it("shows the proposed values and a pull request link", () => {
    render(
      <BoardCard
        item={item()}
        doneStatuses={["done"]}
        defaultBranch="main"
        proposed={[
          {
            branch: "snoboard/edits-20261001-120000-ab12",
            initiativeId: "acme-002",
            fields: [{ field: "status", value: "review" }],
            pr: { number: 4, url: "https://github.com/acme/board/pull/4" },
          },
        ]}
      />,
    );
    expect(screen.getByTestId("proposed-badge").textContent).toContain("proposed");
    expect(screen.getByTestId("proposed-value").textContent).toBe("status: review");
    expect(screen.getByTestId("proposed-pr").getAttribute("href")).toBe("https://github.com/acme/board/pull/4");
  });

  it("shows initiative titles on proposed lines that are ids", () => {
    render(
      <BoardCard
        item={item()}
        doneStatuses={["done"]}
        defaultBranch="main"
        titles={new Map([["acme-001", "Reports"]])}
        proposed={[
          {
            branch: "snoboard/edits-20261001-120000-ab12",
            initiativeId: "acme-002",
            fields: [{ field: "depends_on", value: "acme-001, acme-009" }],
          },
        ]}
      />,
    );
    const line = screen.getByTestId("proposed-value");
    expect(line.textContent).toBe("depends_on: acme-001 · Reports, acme-009");
    expect(line.getAttribute("title")).toBe("depends_on: acme-001 · Reports, acme-009");
    expect(line.className).toContain("truncate");
  });

  it("stays hidden when nothing is proposed", () => {
    render(<BoardCard item={item()} doneStatuses={["done"]} defaultBranch="main" proposed={[]} />);
    expect(screen.queryByTestId("proposed-badge")).toBeNull();
    expect(screen.queryByTestId("proposed-pr")).toBeNull();
  });
});

describe("issue count", () => {
  it("shows how many issues the card lists", () => {
    render(
      <BoardCard
        item={{ ...item(), issues: ["gh#12", "gh:acme/widgets#45", "vikunja:34"] }}
        doneStatuses={["done"]}
        defaultBranch="main"
      />,
    );
    expect(screen.getByTestId("issue-count").textContent).toContain("3");
    expect(screen.getByTestId("issue-count").getAttribute("aria-label")).toBe("3 issues");
  });

  it("stays hidden when the initiative has no issues", () => {
    render(<BoardCard item={item()} doneStatuses={["done"]} defaultBranch="main" />);
    expect(screen.queryByTestId("issue-count")).toBeNull();
  });
});

describe("pending badge", () => {
  it("shows a pending badge and the queued value", () => {
    render(
      <BoardCard
        item={item()}
        doneStatuses={["done"]}
        defaultBranch="main"
        pending={[{ kind: "setStatus", id: "acme-002", from: "in-progress", to: "review" }]}
      />,
    );
    expect(screen.getByTestId("pending-badge").textContent).toBe("pending");
    expect(screen.getByTestId("pending-value").textContent).toBe("in-progress → review");
  });
});

describe("report count", () => {
  it("shows how many reports the initiative has, from the board payload", () => {
    const withReports = {
      ...item(),
      reports: [
        { name: "final.report", formats: ["md" as const, "html" as const] },
        { name: "phase-1.report", formats: ["md" as const], phase: 1 },
      ],
    };
    render(<BoardCard item={withReports} doneStatuses={["done"]} defaultBranch="main" />);
    expect(screen.getByTestId("report-count").textContent).toBe("2 reports");
  });

  it("stays hidden without reports", () => {
    render(<BoardCard item={item()} doneStatuses={["done"]} defaultBranch="main" />);
    expect(screen.queryByTestId("report-count")).toBeNull();
  });
});
