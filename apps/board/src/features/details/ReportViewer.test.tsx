// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserLocation } from "@/features/board/sync";
import { DetailsSheet } from "./DetailsSheet";
import { HtmlReport } from "./ReportViewer";
import {
  orderedReports,
  phaseChipLabel,
  reportImageSrc,
  reportLinkTarget,
  resolveInFolder,
  splitReports,
  type Report,
} from "./report-links.js";

const forge = {
  type: "github" as const,
  repo: "acme/board",
  fileUrl: "https://github.com/{repo}/blob/{ref}/{path}",
  prUrl: "https://github.com/{repo}/pull/{pr}",
};

const reports: Report[] = [
  { name: "final.report", formats: ["md", "html"] },
  { name: "phase-1.report", formats: ["md"], phase: 1 },
  { name: "phase-2.review-plan", formats: ["html"], phase: 2 },
  { name: "phase-9.orphan", formats: ["md"], phase: 9 },
];

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
    forge,
    phases: [
      { id: 1, title: "Design", status: "done" },
      { id: 2, title: "Build", status: "in-progress" },
    ],
    reports,
  };
}

function respond(url: string): Response {
  if (url.endsWith("/reports/final.report.md")) {
    return new Response(
      [
        "# Final report",
        "",
        "See [phase 1](./phase-1.report.md), [the spec](../spec.md) and [docs](https://example.com/docs).",
        "",
        "![chart](../assets/chart.png) ![shot](./shot.png) ![remote](https://tracker.example/x.png)",
        "",
        "<script>alert(1)</script>",
        "",
      ].join("\n"),
      { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
  if (url.endsWith("/reports/phase-1.report.md")) {
    return new Response("# Phase one notes\n", { status: 200 });
  }
  return new Response(JSON.stringify(details()), { status: 200, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  vi.spyOn(browserLocation, "assign").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("report helpers", () => {
  it("splits initiative-level and phase reports; unknown phases stay initiative-level", () => {
    const groups = splitReports(details());
    expect(groups.initiative.map((report) => report.name)).toEqual(["final.report", "phase-9.orphan"]);
    expect(groups.byPhase.get(1)?.map((report) => report.name)).toEqual(["phase-1.report"]);
    expect(orderedReports(details()).map((report) => report.name)).toEqual([
      "final.report",
      "phase-9.orphan",
      "phase-1.report",
      "phase-2.review-plan",
    ]);
    expect(phaseChipLabel("phase-2.review-plan")).toBe("review-plan");
    expect(phaseChipLabel("phase-2")).toBe("report");
  });

  it("resolves relative paths only inside the initiative folder", () => {
    expect(resolveInFolder("../assets/x.png", "final.report")).toBe("assets/x.png");
    expect(resolveInFolder("./img.png", "final.report")).toBe("reports/img.png");
    expect(resolveInFolder("img.png", "sub/plan")).toBe("reports/sub/img.png");
    expect(resolveInFolder("../../x.png", "final.report")).toBeUndefined();
    expect(resolveInFolder("%2e%2e/%2e%2e/x.png", "final.report")).toBeUndefined();
    expect(resolveInFolder("/etc/passwd", "final.report")).toBeUndefined();
    expect(resolveInFolder("https://example.com/x.png", "final.report")).toBeUndefined();
    expect(resolveInFolder("data:image/png;base64,AAAA", "final.report")).toBeUndefined();
  });

  it("rewrites images to the authenticated endpoints and blocks the rest", () => {
    const context = { repoId: "default", id: "acme-002", name: "final.report" };
    expect(reportImageSrc("../assets/chart.png", context)).toBe("/api/repos/default/initiatives/acme-002/assets/chart.png");
    expect(reportImageSrc("./shots/a.png", context)).toBe(
      "/api/repos/default/initiatives/acme-002/reports/shots/a.png",
    );
    expect(reportImageSrc("../diagram.png", context)).toBe("");
    expect(reportImageSrc("./x.svg", context)).toBe("");
    expect(reportImageSrc("https://tracker.example/x.png", context)).toBe("");
    expect(reportImageSrc("//tracker.example/x.png", context)).toBe("");
  });

  it("opens linked reports in the dialog and other folder files on the forge (https only)", () => {
    const context = {
      name: "final.report",
      reports,
      forge,
      sourceRef: "main",
      folder: "initiatives/acme/002-billing",
    };
    expect(reportLinkTarget("./phase-1.report.md", context)).toEqual({ kind: "report", index: 1, format: "md" });
    expect(reportLinkTarget("final.report.html", context)).toEqual({ kind: "report", index: 0, format: "html" });
    expect(reportLinkTarget("../spec.md", context)).toEqual({
      kind: "external",
      href: "https://github.com/acme/board/blob/main/initiatives/acme/002-billing/spec.md",
    });
    expect(reportLinkTarget("javascript:alert(1)", context)).toEqual({ kind: "none" });
    expect(reportLinkTarget("http://example.com", context)).toEqual({ kind: "none" });
    expect(reportLinkTarget("#top", context)).toEqual({ kind: "anchor", href: "#top" });
    expect(
      reportLinkTarget("../spec.md", { ...context, forge: { ...forge, fileUrl: "http://git.example/{path}" } }),
    ).toEqual({ kind: "none" });
  });
});

describe("HTML reports", () => {
  it("render in a sandboxed frame with no scripts and no same-origin access", () => {
    render(<HtmlReport src="/api/repos/default/initiatives/acme-002/reports/final.report.html" title="final" />);
    const frame = screen.getByTestId("report-frame");
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.hasAttribute("srcdoc")).toBe(false);
    expect(frame.getAttribute("src")).toBe("/api/repos/default/initiatives/acme-002/reports/final.report.html");
  });
});

describe("report viewer", () => {
  it("lists reports, opens, toggles format, navigates and closes", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => respond(String(input)));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<DetailsSheet openId="acme-002" onOpenChange={() => {}} />);

    const section = await screen.findByTestId("reports-section");
    expect(within(section).getByText("final.report")).toBeTruthy();
    expect(within(section).getByText("phase-9.orphan")).toBeTruthy();
    expect(within(screen.getByTestId("phase-reports-1")).getByText("report")).toBeTruthy();
    expect(within(screen.getByTestId("phase-reports-2")).getByText("review-plan")).toBeTruthy();

    await user.click(screen.getByTestId("report-open-final.report"));
    const dialog = await screen.findByTestId("report-dialog");
    await within(dialog).findByText("Final report", {}, { timeout: 5000 });
    expect(within(dialog).getByTestId("report-position").textContent).toBe("1 / 4");
    expect(dialog.querySelector("script")).toBeNull();
    const images = [...dialog.querySelectorAll("img")].map((image) => image.getAttribute("src"));
    expect(images).toEqual([
      "/api/repos/default/initiatives/acme-002/assets/chart.png",
      "/api/repos/default/initiatives/acme-002/reports/shot.png",
    ]);
    expect(within(dialog).getByTestId("blocked-image")).toBeTruthy();
    const spec = within(dialog).getByRole("link", { name: "the spec" });
    expect(spec.getAttribute("href")).toBe("https://github.com/acme/board/blob/main/initiatives/acme/002-billing/spec.md");
    expect(within(dialog).getByTestId("report-raw").getAttribute("href")).toBe(
      "https://github.com/acme/board/blob/main/initiatives/acme/002-billing/reports/final.report.md",
    );

    await user.click(within(dialog).getByTestId("report-format-html"));
    const frame = await within(dialog).findByTestId("report-frame");
    expect(frame.getAttribute("sandbox")).toBe("");
    await user.click(within(dialog).getByTestId("report-format-md"));
    await within(dialog).findByText("Final report");

    await user.click(within(dialog).getByRole("link", { name: "phase 1" }));
    await within(dialog).findByText("Phase one notes");
    expect(within(dialog).getByTestId("report-position").textContent).toBe("3 / 4");

    await user.click(within(dialog).getByTestId("report-next"));
    expect(await within(dialog).findByTestId("report-frame")).toBeTruthy();
    expect(within(dialog).getByTestId("report-position").textContent).toBe("4 / 4");
    expect((within(dialog).getByTestId("report-next") as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(dialog).getByTestId("report-prev"));
    expect(within(dialog).getByTestId("report-position").textContent).toBe("3 / 4");

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("report-dialog")).toBeNull());
    expect(screen.getByTestId("details-sheet")).toBeTruthy();
  });
});
