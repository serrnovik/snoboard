// @vitest-environment jsdom

import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import type { Edit } from "snoboard/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BasketPanel } from "@/features/basket/BasketPanel";
import { resetBasketStore, useBasket } from "@/features/basket/store";
import { pullBasket, resetAgentBridge, type AgentConfig, setAgentStateForTests, startAgentBridge, syncBaseKey, type Proposal } from "./bridge";
import { CopyPromptButton } from "./CopyPromptButton";
import { InboxPanel } from "./Inbox";
import { InitiativeProposals } from "./ProposalNotice";

const CONFIG: AgentConfig = { enabled: true, available: true, user: { display: "ada" }, tools: [], csrf: "csrf-token" };

function proposal(id: string, edits: Edit[], extra: Partial<Proposal> = {}): Proposal {
  return {
    id,
    repo: "default",
    branch: "main",
    source: "laptop",
    note: "",
    edits,
    status: "pending",
    created: "2026-10-11T10:00:00.000Z",
    decided: null,
    ...extra,
  };
}

type Call = { url: string; method: string; body: unknown };

function mockFetch(handler: (call: Call) => unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const call = { url: String(input), method: init?.method ?? "GET", body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) };
      calls.push(call);
      const result = handler(call);
      return new Response(JSON.stringify(result ?? {}), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}

beforeEach(() => {
  vi.stubGlobal("EventSource", undefined);
});

afterEach(() => {
  cleanup();
  resetAgentBridge();
  resetBasketStore();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("inbox", () => {
  it("lists pending proposals with their edits and accepts or rejects them", async () => {
    const user = userEvent.setup();
    const proposals = [
      proposal("p_one", [{ kind: "setStatus", id: "acme-002", from: "in-progress", to: "review" }], { note: "ready for review" }),
      proposal("p_two", [{ kind: "setPriority", id: "acme-002", from: "p1", to: "p0" }]),
      proposal("p_old", [{ kind: "setPriority", id: "acme-001", from: "p1", to: "p0" }], { status: "rejected", decided: "2026-10-11T11:00:00.000Z" }),
    ];
    const calls = mockFetch((call) => {
      const decided = /^\/api\/agent\/proposals\/([^/]+)\/(accept|reject)$/.exec(call.url);
      if (decided !== null) {
        const target = proposals.find((entry) => entry.id === decided[1])!;
        target.status = decided[2] === "accept" ? "accepted" : "rejected";
        return {};
      }
      if (call.url === "/api/agent/proposals") return { proposals };
      return { edits: [], updated: 1 };
    });
    setAgentStateForTests({ config: CONFIG, proposals: proposals.map((entry) => ({ ...entry })) });
    render(<InboxPanel repoId="default" />);
    expect(screen.getAllByTestId("proposal-card")).toHaveLength(2);
    expect(screen.getByText("ready for review")).toBeTruthy();
    expect(screen.getAllByTestId("proposal-edit").map((node) => node.textContent)).toEqual([
      "acme-002 · acme-002 — in-progress → review",
      "acme-002 · acme-002 — priority p1 → p0",
    ]);
    expect(screen.getAllByTestId("inbox-decided")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Accept proposal p_one" }));
    await waitFor(() => expect(calls.some((call) => call.url === "/api/agent/proposals/p_one/accept")).toBe(true));
    const accept = calls.find((call) => call.url === "/api/agent/proposals/p_one/accept")!;
    expect(accept).toMatchObject({ method: "POST", body: { csrf: "csrf-token" } });
    // Accepting pulls the basket it went into.
    await waitFor(() => expect(calls.some((call) => call.url === "/api/agent/basket?repo=default&branch=main")).toBe(true));

    await user.click(screen.getByRole("button", { name: "Reject proposal p_two" }));
    await waitFor(() => expect(calls.some((call) => call.url === "/api/agent/proposals/p_two/reject")).toBe(true));
  });

  it("accepts all and shows text diffs against the committed version", async () => {
    const user = userEvent.setup();
    const calls = mockFetch((call) => {
      if (call.url.includes("/doc-source/")) return { text: "# Roadmap\n\nOld.\n", hash: "x" };
      if (call.url === "/api/agent/proposals") return { proposals: [] };
      return { accepted: [], failed: [] };
    });
    setAgentStateForTests({
      config: CONFIG,
      proposals: [
        proposal("p_doc", [{ kind: "setDoc", id: "acme-001", path: "ROADMAP.md", fromHash: "a".repeat(64), to: "# Roadmap\n\nNew.\n" }]),
        proposal("p_status", [{ kind: "setStatus", id: "acme-001", from: "done", to: "idea" }]),
      ],
    });
    render(<InboxPanel repoId="default" />);
    await user.click(screen.getByRole("button", { name: "Show diff" }));
    const diff = await screen.findByTestId("diff-view");
    expect(diff.querySelector('[data-diff="del"]')?.textContent).toContain("Old.");
    expect(diff.querySelector('[data-diff="add"]')?.textContent).toContain("New.");
    expect(calls.some((call) => call.url === "/api/repos/default/initiatives/acme-001/doc-source/ROADMAP.md?ref=main")).toBe(true);

    await user.click(screen.getByTestId("inbox-accept-all"));
    await waitFor(() => expect(calls.some((call) => call.url === "/api/agent/proposals/accept-all")).toBe(true));
  });

  it("shows proposals for the open initiative in the details panel", () => {
    mockFetch(() => ({}));
    setAgentStateForTests({
      config: CONFIG,
      proposals: [
        proposal("p_mine", [
          { kind: "setStatus", id: "acme-002", from: "in-progress", to: "review" },
          { kind: "setStatus", id: "acme-003", from: "idea", to: "planned" },
        ]),
        proposal("p_other", [{ kind: "setStatus", id: "acme-001", from: "done", to: "idea" }]),
      ],
    });
    render(<InitiativeProposals repoId="default" id="acme-002" />);
    const section = screen.getByTestId("initiative-proposals");
    expect(section.textContent).toContain("An agent proposes changes");
    expect(screen.getAllByTestId("proposal-edit")).toHaveLength(1);
    expect(section.textContent).toContain("It also changes other initiatives");
  });
});

describe("copy prompt for agent", () => {
  it("is hidden without the bridge and copies the prompt with it", async () => {
    const user = userEvent.setup();
    const target = { repoId: "default", initiative: { id: "acme-002", title: "Billing", path: "initiatives/acme/002-billing/initiative.md" } };
    const { rerender } = render(<CopyPromptButton target={target} />);
    expect(screen.queryByTestId("copy-agent-prompt")).toBeNull();

    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    act(() => setAgentStateForTests({ config: CONFIG }));
    rerender(<CopyPromptButton target={target} />);
    await user.click(screen.getByTestId("copy-agent-prompt"));
    expect(writeText).toHaveBeenCalledTimes(1);
    const text = (writeText.mock.calls[0] as unknown as [string])[0];
    expect(text).toContain("acme-002 — Billing");
    expect(text).toContain("- Branch: main");
    expect(text).toContain("propose_edits");
    expect(screen.getByTestId("copy-agent-prompt").textContent).toContain("Copied");
  });

  it("is offered on a basket with pending edits", () => {
    act(() => setAgentStateForTests({ config: CONFIG }));
    const { result } = renderHook(() => useBasket("default"));
    act(() => result.current.add({ kind: "setStatus", id: "acme-001", from: "idea", to: "done" }));
    render(<BasketPanel enabled canSubmit={false} repoId="default" />);
    expect(screen.getByTestId("copy-agent-prompt-basket")).toBeTruthy();
  });
});

describe("server basket sync", () => {
  const edit = (to: string): Edit => ({ kind: "setStatus", id: "acme-001", from: "idea", to });

  it("adopts the server basket when this device has no changes, and pushes local changes with their keys", async () => {
    let server = { edits: [edit("planned")] as Edit[], updated: 10 };
    const calls = mockFetch((call) => {
      if (call.url === "/api/agent/config") return CONFIG;
      if (call.url === "/api/agent/proposals") return { proposals: [] };
      if (call.url.startsWith("/api/agent/basket") && call.method === "GET") return server;
      if (call.url === "/api/agent/basket" && call.method === "PUT") {
        const body = call.body as { edits: Edit[] };
        server = { edits: body.edits, updated: server.updated + 1 };
        return server;
      }
      return {};
    });
    await startAgentBridge();
    const { result } = renderHook(() => useBasket("default"));
    await waitFor(() => expect(result.current.edits).toEqual([edit("planned")]));
    expect(JSON.parse(localStorage.getItem(syncBaseKey("default", "main")) ?? "{}")).toMatchObject({ updated: 10 });

    act(() => result.current.add({ kind: "setPriority", id: "acme-002", from: "p1", to: "p0" }));
    await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true), { timeout: 2000 });
    const put = calls.find((call) => call.method === "PUT")!.body as { baseUpdated: number; changedKeys: string[]; removedKeys: string[]; csrf: string };
    expect(put).toMatchObject({ baseUpdated: 10, changedKeys: ["setPriority:acme-002"], removedKeys: [], csrf: "csrf-token" });

    // Another device changed the server basket: an event (or reload) pulls it in.
    server = { edits: [edit("done")], updated: 50 };
    await act(() => pullBasket("default", "main"));
    await waitFor(() => expect(result.current.edits).toEqual([edit("done")]));
  });
});
