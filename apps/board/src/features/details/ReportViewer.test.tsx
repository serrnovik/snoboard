// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserLocation } from "@/features/board/sync";
import { DetailsSheet } from "./DetailsSheet";
import { HtmlReport } from "./ReportViewer";
import {
  docChipLabel,
  docImageSrc,
  docLinkTarget,
  resolveFromDoc,
  splitDocs,
  viewerDocs,
  type DocEntry,
} from "./doc-links.js";
import { orderedReports, phaseChipLabel, splitReports, type Report } from "./report-links.js";

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

const docs: DocEntry[] = [
  { path: "phases/phase-1.packet", kind: "phase-doc", formats: ["md"], title: "phase-1.packet", phase: 1 },
  { path: "phases/phase-1/T1.1-schema", kind: "task", formats: ["md"], title: "T1.1-schema", phase: 1 },
  { path: "phases/README", kind: "phase-doc", formats: ["md"], title: "README" },
  { path: "ROADMAP", kind: "initiative-doc", formats: ["md", "html"], title: "ROADMAP" },
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
    docs,
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
  if (url.endsWith("/docs/ROADMAP.md")) {
    return new Response(
      [
        "# Roadmap",
        "",
        "Start with [the phase 1 packet](phases/phase-1.packet.md#scope) and [jump down](#later).",
        "",
        "## Later",
        "",
      ].join("\n"),
      { status: 200 },
    );
  }
  if (url.endsWith("/docs/phases/phase-1.packet.md")) {
    return new Response(
      ["# Phase 1 packet", "", "Back to [the roadmap](../ROADMAP.md), task [T1.1](phase-1/T1.1-schema.md).", "", "## Scope", ""].join("\n"),
      { status: 200 },
    );
  }
  if (url.endsWith("/docs/phases/phase-1/T1.1-schema.md")) {
    return new Response("# Schema task\n\n![flow](../img/flow.png)\n", { status: 200 });
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
    expect(resolveFromDoc("../assets/x.png", "reports/final.report")).toBe("assets/x.png");
    expect(resolveFromDoc("./img.png", "reports/final.report")).toBe("reports/img.png");
    expect(resolveFromDoc("img.png", "reports/sub/plan")).toBe("reports/sub/img.png");
    expect(resolveFromDoc("phases/phase-1.packet.md#scope", "ROADMAP")).toBe("phases/phase-1.packet.md");
    expect(resolveFromDoc("../ROADMAP.md", "phases/phase-1.packet")).toBe("ROADMAP.md");
    expect(resolveFromDoc("../../x.png", "reports/final.report")).toBeUndefined();
    expect(resolveFromDoc("../x.md", "ROADMAP")).toBeUndefined();
    expect(resolveFromDoc("%2e%2e/%2e%2e/x.png", "reports/final.report")).toBeUndefined();
    expect(resolveFromDoc("/etc/passwd", "ROADMAP")).toBeUndefined();
    expect(resolveFromDoc("https://example.com/x.png", "ROADMAP")).toBeUndefined();
    expect(resolveFromDoc("data:image/png;base64,AAAA", "ROADMAP")).toBeUndefined();
  });

  it("rewrites images to the authenticated endpoints and blocks the rest", () => {
    const context = { repoId: "default", id: "acme-002", from: "reports/final.report" };
    expect(docImageSrc("../assets/chart.png", context)).toBe("/api/repos/default/initiatives/acme-002/assets/chart.png");
    expect(docImageSrc("./shots/a.png", context)).toBe("/api/repos/default/initiatives/acme-002/docs/reports/shots/a.png");
    expect(docImageSrc("../diagram.png", context)).toBe("/api/repos/default/initiatives/acme-002/docs/diagram.png");
    expect(docImageSrc("../img/flow.png", { ...context, from: "phases/phase-1/T1.1-schema" })).toBe(
      "/api/repos/default/initiatives/acme-002/docs/phases/img/flow.png",
    );
    expect(docImageSrc("../../x.png", context)).toBe("");
    expect(docImageSrc("./x.svg", context)).toBe("");
    expect(docImageSrc("https://tracker.example/x.png", context)).toBe("");
    expect(docImageSrc("//tracker.example/x.png", context)).toBe("");
  });

  it("opens linked documents and reports in the viewer and other folder files on the forge (https only)", () => {
    const all = viewerDocs(details());
    const context = { from: "reports/final.report", docs: all, forge, sourceRef: "main", folder: "initiatives/acme/002-billing" };
    const at = (key: string) => all.findIndex((doc) => doc.key === key);
    expect(docLinkTarget("./phase-1.report.md", context)).toEqual({ kind: "doc", index: at("reports/phase-1.report"), format: "md" });
    expect(docLinkTarget("final.report.html", context)).toEqual({ kind: "doc", index: at("reports/final.report"), format: "html" });
    expect(docLinkTarget("../ROADMAP.md", context)).toEqual({ kind: "doc", index: at("ROADMAP"), format: "md" });
    expect(docLinkTarget("phases/phase-1.packet.md#scope", { ...context, from: "ROADMAP" })).toEqual({
      kind: "doc",
      index: at("phases/phase-1.packet"),
      format: "md",
      anchor: "scope",
    });
    expect(docLinkTarget("phase-1/T1.1-schema.md", { ...context, from: "phases/phase-1.packet" })).toEqual({
      kind: "doc",
      index: at("phases/phase-1/T1.1-schema"),
      format: "md",
    });
    expect(docLinkTarget("../spec.md", context)).toEqual({
      kind: "external",
      href: "https://github.com/acme/board/blob/main/initiatives/acme/002-billing/spec.md",
    });
    expect(docLinkTarget("javascript:alert(1)", context)).toEqual({ kind: "none" });
    expect(docLinkTarget("http://example.com", context)).toEqual({ kind: "none" });
    expect(docLinkTarget("#top", context)).toEqual({ kind: "anchor", id: "top" });
    expect(
      docLinkTarget("../spec.md", { ...context, forge: { ...forge, fileUrl: "http://git.example/{path}" } }),
    ).toEqual({ kind: "none" });
  });

  it("orders the viewer as Initiative, Phase N, Reports and labels phase chips", () => {
    expect(viewerDocs(details()).map((doc) => `${doc.group}:${doc.key}`)).toEqual([
      "Initiative:phases/README",
      "Initiative:ROADMAP",
      "Phase 1:phases/phase-1.packet",
      "Phase 1:phases/phase-1/T1.1-schema",
      "Reports:reports/final.report",
      "Reports:reports/phase-9.orphan",
      "Reports:reports/phase-1.report",
      "Reports:reports/phase-2.review-plan",
    ]);
    expect(splitDocs(details()).byPhase.get(1)?.map((doc) => doc.kind)).toEqual(["phase-doc", "task"]);
    expect(docChipLabel({ title: "phase-1.packet", kind: "phase-doc" })).toBe("packet");
    expect(docChipLabel({ title: "phase-2a.packet", kind: "phase-doc" })).toBe("packet");
    expect(docChipLabel({ title: "phase-3.1.packet", kind: "phase-doc" })).toBe("packet");
    expect(docChipLabel({ title: "00-investigation", kind: "phase-doc" })).toBe("investigation");
    expect(docChipLabel({ title: "phase-4", kind: "phase-doc" })).toBe("phase-4");
    expect(docChipLabel({ title: "T1.1-schema", kind: "task" })).toBe("T1.1-schema");
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
    expect(within(dialog).getByTestId("report-position").textContent).toBe("5 / 8");
    expect(dialog.querySelector("script")).toBeNull();
    const images = [...dialog.querySelectorAll("img")].map((image) => image.getAttribute("src"));
    expect(images).toEqual([
      "/api/repos/default/initiatives/acme-002/assets/chart.png",
      "/api/repos/default/initiatives/acme-002/docs/reports/shot.png",
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
    expect(within(dialog).getByTestId("report-position").textContent).toBe("7 / 8");

    await user.click(within(dialog).getByTestId("report-next"));
    expect(await within(dialog).findByTestId("report-frame")).toBeTruthy();
    expect(within(dialog).getByTestId("report-position").textContent).toBe("8 / 8");
    expect((within(dialog).getByTestId("report-next") as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(dialog).getByTestId("report-prev"));
    expect(within(dialog).getByTestId("report-position").textContent).toBe("7 / 8");

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("report-dialog")).toBeNull());
    expect(screen.getByTestId("details-sheet")).toBeTruthy();
  });
});

describe("document viewer", () => {
  it("lists documents, opens phase packets and tasks, follows relative links and anchors", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => respond(String(input)));
    vi.stubGlobal("fetch", fetchMock);
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
      scrolled.push(this.id);
    };
    const user = userEvent.setup();
    render(<DetailsSheet openId="acme-002" onOpenChange={() => {}} />);

    const section = await screen.findByTestId("docs-section");
    expect(within(section).getByText("ROADMAP")).toBeTruthy();
    expect(within(section).getByText("phases/README")).toBeTruthy();
    const phase = screen.getByTestId("phase-docs-1");
    expect(within(phase).getByText("packet")).toBeTruthy();
    expect(screen.queryByTestId("phase-tasks-1")).toBeNull();
    await user.click(within(phase).getByTestId("phase-tasks-toggle-1"));
    expect(within(screen.getByTestId("phase-tasks-1")).getByText("T1.1-schema")).toBeTruthy();
    expect(screen.queryByTestId("phase-docs-2")).toBeNull();

    await user.click(within(section).getByTestId("doc-open-ROADMAP"));
    const dialog = await screen.findByTestId("report-dialog");
    await within(dialog).findByRole("heading", { name: "Roadmap" }, { timeout: 5000 });
    expect(within(dialog).getByTestId("report-position").textContent).toBe("2 / 8");
    expect(within(dialog).getByTestId("doc-nav-ROADMAP").getAttribute("aria-current")).toBe("page");
    const nav = within(dialog).getByTestId("doc-nav");
    expect([...nav.querySelectorAll("h3")].map((heading) => heading.textContent)).toEqual(["Initiative", "Phase 1", "Reports"]);
    expect(within(dialog).getByTestId("report-raw").getAttribute("href")).toBe(
      "https://github.com/acme/board/blob/main/initiatives/acme/002-billing/ROADMAP.md",
    );
    expect(within(dialog).getByTestId("report-raw").textContent).toContain("Open on GitHub");
    expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/repos/default/initiatives/acme-002/docs/ROADMAP.md")).toBe(true);

    await user.click(within(dialog).getByRole("link", { name: "jump down" }));
    await waitFor(() => expect(scrolled.at(-1)).toMatch(/later$/));

    await user.click(within(dialog).getByRole("link", { name: "the phase 1 packet" }));
    await within(dialog).findByRole("heading", { name: "Phase 1 packet" });
    expect(within(dialog).getByTestId("report-position").textContent).toBe("3 / 8");
    await waitFor(() => expect(scrolled.at(-1)).toMatch(/scope$/));

    await user.click(within(dialog).getByRole("link", { name: "T1.1" }));
    await within(dialog).findByRole("heading", { name: "Schema task" });
    expect([...dialog.querySelectorAll("img")].map((image) => image.getAttribute("src"))).toEqual([
      "/api/repos/default/initiatives/acme-002/docs/phases/img/flow.png",
    ]);

    await user.click(within(dialog).getByTestId("doc-nav-reports/final.report"));
    await within(dialog).findByText("Final report");
    expect(within(dialog).getByTestId("report-position").textContent).toBe("5 / 8");
  });
});
