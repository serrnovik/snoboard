// @vitest-environment jsdom

import { cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserLocation } from "@/features/board/sync";
import { describeEdit, resetBasketStore, useBasket } from "@/features/basket/store";
import { DetailsSheet } from "./DetailsSheet";
import { phasePacketTemplate, withPendingDocs, type DocEntry } from "./doc-links.js";

// The real editor is covered in markdown-editor.test.tsx; here a textarea stands in for it.
vi.mock("@/components/markdown-editor-impl", () => ({
  default: (props: { value: string; onChange: (value: string) => void; "aria-label": string }) => (
    <textarea
      data-testid="markdown-editor"
      aria-label={props["aria-label"]}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
    />
  ),
}));

const HASH = "cd".repeat(32);
const ROADMAP = "# Roadmap\n\nCommitted plan.\n";

const docs: DocEntry[] = [
  { path: "phases/phase-1.packet", kind: "phase-doc", formats: ["md"], title: "phase-1.packet", phase: 1 },
  { path: "ROADMAP", kind: "initiative-doc", formats: ["md", "html"], title: "ROADMAP" },
  { path: "VISUAL", kind: "initiative-doc", formats: ["html"], title: "VISUAL" },
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
    forge: {
      type: "github" as const,
      repo: "acme/board",
      fileUrl: "https://github.com/{repo}/blob/{ref}/{path}",
      prUrl: "https://github.com/{repo}/pull/{pr}",
    },
    phases: [
      { id: 1, title: "Design", status: "done" },
      { id: 2, title: "Build", status: "in-progress" },
    ],
    docs,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function mockApis(enabled = true) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/edit-config")) {
      return json({ enabled, modes: ["direct"], canSubmit: true, needsGithubWrite: false, defaultMode: "direct" });
    }
    if (url.endsWith("/doc-source/ROADMAP.md")) return json({ text: ROADMAP, hash: HASH });
    if (url.endsWith("/doc-source/phases/phase-1.packet.md")) {
      return json({ code: "too_large", error: "phases/phase-1.packet.md is too large to edit in the board (over 60000 characters)" }, 422);
    }
    if (url.endsWith("/docs/ROADMAP.md")) return new Response(ROADMAP, { status: 200 });
    if (url.endsWith("/docs/phases/phase-1.packet.md")) return new Response("# Phase 1 packet\n", { status: 200 });
    return json(details());
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.spyOn(browserLocation, "assign").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  resetBasketStore();
});

describe("document editing in the viewer", () => {
  it("edits a document, queues setDoc, and renders the pending version with badges", async () => {
    mockApis();
    const user = userEvent.setup();
    const basket = renderHook(() => useBasket());
    render(<DetailsSheet openId="acme-002" onOpenChange={() => {}} />);

    await user.click(await screen.findByTestId("doc-open-ROADMAP"));
    const dialog = await screen.findByTestId("report-dialog");
    await waitFor(() => expect(within(dialog).getByTestId("doc-content").textContent).toContain("Committed plan."), { timeout: 3000 });
    await user.click(await within(dialog).findByTestId("doc-edit"));
    const editor = (await within(dialog).findByRole("textbox", { name: "Edit ROADMAP.md" })) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe(ROADMAP));

    // Cancel leaves the basket alone.
    await user.click(within(dialog).getByTestId("doc-edit-cancel"));
    expect(basket.result.current.edits).toEqual([]);
    await within(dialog).findByText("Committed plan.");

    await user.click(within(dialog).getByTestId("doc-edit"));
    const again = (await within(dialog).findByRole("textbox", { name: "Edit ROADMAP.md" })) as HTMLTextAreaElement;
    await waitFor(() => expect(again.value).toBe(ROADMAP));
    fireEvent.change(again, { target: { value: "# Roadmap\n\nEdited plan.\n" } });
    await user.click(within(dialog).getByTestId("doc-edit-save"));

    await waitFor(() =>
      expect(basket.result.current.edits).toEqual([
        { kind: "setDoc", id: "acme-002", path: "ROADMAP.md", fromHash: HASH, to: "# Roadmap\n\nEdited plan.\n" },
      ]),
    );
    await within(dialog).findByText("Edited plan.");
    expect(within(dialog).queryByText("Committed plan.")).toBeNull();
    expect(within(dialog).getByTestId("doc-pending-current").textContent).toBe("pending");
    expect(within(dialog).getByTestId("doc-pending-ROADMAP").textContent).toBe("pending");
    expect(within(dialog).getByTestId("doc-pending-note")).toBeTruthy();
    expect(describeEdit(basket.result.current.edits[0]!)).toBe("acme-002 · ROADMAP.md — edited");

    // Editing again starts from the pending text and keeps the first hash.
    await user.click(within(dialog).getByTestId("doc-edit"));
    const third = (await within(dialog).findByRole("textbox", { name: "Edit ROADMAP.md" })) as HTMLTextAreaElement;
    expect(third.value).toBe("# Roadmap\n\nEdited plan.\n");
    fireEvent.change(third, { target: { value: "# Roadmap\n\nFinal plan.\n" } });
    await user.click(within(dialog).getByTestId("doc-edit-save"));
    await waitFor(() =>
      expect(basket.result.current.edits).toEqual([
        { kind: "setDoc", id: "acme-002", path: "ROADMAP.md", fromHash: HASH, to: "# Roadmap\n\nFinal plan.\n" },
      ]),
    );
  });

  it("explains why a large document cannot be edited", async () => {
    mockApis();
    const user = userEvent.setup();
    render(<DetailsSheet openId="acme-002" onOpenChange={() => {}} />);
    await user.click(await screen.findByTestId("doc-chip-phases/phase-1.packet"));
    const dialog = await screen.findByTestId("report-dialog");
    await user.click(await within(dialog).findByTestId("doc-edit"));
    expect((await within(dialog).findByTestId("doc-edit-error")).textContent).toContain("too large to edit");
  });

  it("creates a phase packet from the template as createDoc", async () => {
    mockApis();
    const user = userEvent.setup();
    const basket = renderHook(() => useBasket());
    render(<DetailsSheet openId="acme-002" onOpenChange={() => {}} />);
    await user.click(await screen.findByTestId("doc-open-ROADMAP"));
    const dialog = await screen.findByTestId("report-dialog");
    expect(within(dialog).queryByTestId("doc-new-packet-1")).toBeNull();
    await user.click(await within(dialog).findByTestId("doc-new-packet-2"));

    const template = phasePacketTemplate({ id: 2, title: "Build" });
    await waitFor(() =>
      expect(basket.result.current.edits).toEqual([
        { kind: "createDoc", id: "acme-002", path: "phases/phase-2.packet.md", to: template },
      ]),
    );
    const editor = (await within(dialog).findByRole("textbox", {
      name: "Edit phases/phase-2.packet.md",
    })) as HTMLTextAreaElement;
    expect(editor.value).toBe(template);
    expect(within(dialog).getByTestId("doc-pending-phases/phase-2.packet").textContent).toBe("new");
    fireEvent.change(editor, { target: { value: "# Phase 2 packet\n\nBuild it.\n" } });
    await user.click(within(dialog).getByTestId("doc-edit-save"));
    await waitFor(() =>
      expect(basket.result.current.edits).toEqual([
        { kind: "createDoc", id: "acme-002", path: "phases/phase-2.packet.md", to: "# Phase 2 packet\n\nBuild it.\n" },
      ]),
    );
    await within(dialog).findByText("Build it.");
    expect(describeEdit(basket.result.current.edits[0]!)).toBe("acme-002 · phases/phase-2.packet.md — new");
  });

  it("offers no editing when the board is read-only, and never for html-only documents", async () => {
    mockApis(false);
    const user = userEvent.setup();
    render(<DetailsSheet openId="acme-002" onOpenChange={() => {}} />);
    await user.click(await screen.findByTestId("doc-open-ROADMAP"));
    const dialog = await screen.findByTestId("report-dialog");
    await within(dialog).findByText("Committed plan.");
    expect(within(dialog).queryByTestId("doc-edit")).toBeNull();
    expect(within(dialog).queryByTestId("doc-new")).toBeNull();
  });
});

describe("withPendingDocs", () => {
  it("lists documents created in the basket once", () => {
    const pending = new Map([
      ["phases/phase-2.packet.md", { text: "x", created: true }],
      ["ROADMAP.md", { text: "y", created: false }],
    ]);
    const item = withPendingDocs({ docs }, pending);
    expect(item.docs?.map((doc) => [doc.path, doc.kind, doc.phase])).toEqual([
      ["phases/phase-1.packet", "phase-doc", 1],
      ["phases/phase-2.packet", "phase-doc", 2],
      ["ROADMAP", "initiative-doc", undefined],
      ["VISUAL", "initiative-doc", undefined],
    ]);
    expect(withPendingDocs({ docs }, new Map())).toEqual({ docs });
  });
});
