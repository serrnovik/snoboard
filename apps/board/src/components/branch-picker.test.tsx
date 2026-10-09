// @vitest-environment jsdom

import { cleanup, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BranchPicker, branchChoices, highlight, MERGED_LABEL } from "@/components/branch-picker";
import {
  basketStorageKey,
  legacyBasketStorageKey,
  resetBasketStore,
  savedBasketCount,
  useBasket,
} from "@/features/basket/store";
import { BoardRefProvider, refStorageKey, useBoardRef } from "@/features/repo/branch-context";
import { RepoProvider } from "@/features/repo/context";
import { activeRef, repoApi, setActiveRef } from "@/lib/routes";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const BRANCHES = [
  { name: "feat/new-board", sha: "1111111", date: "2026-10-09T12:00:00Z" },
  { name: "main", sha: "2222222", date: "2026-10-01T12:00:00Z" },
  { name: "fix/board-crash", sha: "3333333", date: "2026-09-10T12:00:00Z" },
  { name: "docs/readme", sha: "4444444", date: "2025-01-01T12:00:00Z" },
];
const EDIT = { kind: "setStatus" as const, id: "acme-001", from: "idea", to: "planned" };

afterEach(() => {
  cleanup();
  localStorage.clear();
  resetBasketStore();
  setActiveRef("default", null);
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

function installBranches(): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ defaultBranch: "main", branches: BRANCHES, truncated: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return urls;
}

function Probe() {
  const { ref } = useBoardRef();
  return <output data-testid="ref">{ref ?? "merged"}</output>;
}

function renderPicker(children?: ReactNode) {
  return render(
    <BoardRefProvider repoId="default">
      <BranchPicker now={NOW} />
      <Probe />
      {children}
    </BoardRefProvider>,
  );
}

describe("branchChoices", () => {
  it("lists merged, the default branch, then the rest in server order", () => {
    expect(branchChoices(BRANCHES, "main", "").map((row) => row.label)).toEqual([
      MERGED_LABEL,
      "main",
      "feat/new-board",
      "fix/board-crash",
      "docs/readme",
    ]);
  });

  it("filters by substring, case-insensitively", () => {
    expect(branchChoices(BRANCHES, "main", "BOARD").map((row) => row.label)).toEqual([
      "feat/new-board",
      "fix/board-crash",
    ]);
    expect(branchChoices(BRANCHES, "main", "zzz")).toEqual([]);
  });

  it("marks every match", () => {
    render(<p data-testid="h">{highlight("board/board", "Board")}</p>);
    expect(screen.getByTestId("h").querySelectorAll("mark")).toHaveLength(2);
  });
});

describe("BranchPicker", () => {
  it("shows the active branch as a chip and fetches the list when opened", async () => {
    const urls = installBranches();
    const user = userEvent.setup();
    renderPicker();
    expect(screen.getByTestId("branch-chip").textContent).toContain(MERGED_LABEL);
    expect(urls).toEqual([]);
    await user.click(screen.getByTestId("branch-chip"));
    await screen.findByText("docs/readme");
    expect(urls).toEqual(["/api/repos/default/branches"]);
    const options = screen.getAllByTestId("branch-option");
    expect(options[2]?.textContent).toContain("1111111");
    expect(options[2]?.textContent).toContain("2026-10-09");
    expect(options[2]?.textContent).toContain("1d ago");
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");
  });

  it("filters while typing, highlights matches and picks with the keyboard", async () => {
    installBranches();
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByTestId("branch-chip"));
    await screen.findByText("docs/readme");
    const input = screen.getByRole("combobox");
    expect(document.activeElement).toBe(input);
    await user.type(input, "board");
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent?.split(/\d/)[0])).toEqual(["feat/new-board", "fix/board-crash"]);
    expect(options[0]?.querySelector("mark")?.textContent).toBe("board");
    expect(input.getAttribute("aria-activedescendant")).toBe(options[0]?.id);
    await user.keyboard("{ArrowDown}");
    expect(input.getAttribute("aria-activedescendant")).toBe(options[1]?.id);
    await user.keyboard("{ArrowDown}");
    expect(input.getAttribute("aria-activedescendant")).toBe(options[0]?.id);
    await user.keyboard("{ArrowUp}{Enter}");
    expect(screen.getByTestId("ref").textContent).toBe("fix/board-crash");
    expect(new URLSearchParams(window.location.search).get("ref")).toBe("fix/board-crash");
    expect(localStorage.getItem(refStorageKey("default"))).toBe("fix/board-crash");
    expect(activeRef("default")).toBe("fix/board-crash");
    expect(screen.getByTestId("branch-chip").textContent).toContain("fix/board-crash");
  });

  it("closes on Escape without switching", async () => {
    installBranches();
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByTestId("branch-chip"));
    await screen.findByText("docs/readme");
    await user.keyboard("{ArrowDown}{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByTestId("ref").textContent).toBe("merged");
    expect(document.activeElement).toBe(screen.getByTestId("branch-chip"));
  });

  it("asks before switching with pending edits, keeps them for their branch, and Cancel stays", async () => {
    installBranches();
    const user = userEvent.setup();
    function Seed() {
      const basket = useBasket("default");
      return (
        <button type="button" onClick={() => basket.add(EDIT)}>
          seed
        </button>
      );
    }
    renderPicker(<Seed />);
    await user.click(screen.getByRole("button", { name: "seed" }));

    await user.click(screen.getByTestId("branch-chip"));
    await user.click(await screen.findByText("docs/readme"));
    const dialog = await screen.findByTestId("branch-switch-dialog");
    expect(dialog.textContent).toContain(
      "You have 1 pending edit on main. Switch anyway? They stay saved for main.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId("ref").textContent).toBe("merged");

    await user.click(screen.getByTestId("branch-chip"));
    await user.click(await screen.findByText("docs/readme"));
    await user.click(within(await screen.findByTestId("branch-switch-dialog")).getByRole("button", { name: "Switch" }));
    expect(screen.getByTestId("ref").textContent).toBe("docs/readme");
    expect(savedBasketCount("default", "main", true)).toBe(1);
    expect(savedBasketCount("default", "docs/readme")).toBe(0);
  });

  it("switches without asking when the basket is empty", async () => {
    installBranches();
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByTestId("branch-chip"));
    await user.click(await screen.findByText("main"));
    expect(screen.queryByTestId("branch-switch-dialog")).toBeNull();
    expect(screen.getByTestId("ref").textContent).toBe("main");
  });
});

describe("selected branch: URL, memory and API calls", () => {
  it("?ref= in the URL wins over the remembered branch", async () => {
    localStorage.setItem(refStorageKey("default"), "feat/new-board");
    window.history.replaceState(null, "", "/r/default/?ref=fix%2Fboard-crash");
    render(
      <BoardRefProvider repoId="default">
        <Probe />
      </BoardRefProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("ref").textContent).toBe("fix/board-crash"));
  });

  it("falls back to the remembered branch and puts it in the URL", async () => {
    localStorage.setItem(refStorageKey("default"), "feat/new-board");
    window.history.replaceState(null, "", "/r/default/?project=acme");
    render(
      <BoardRefProvider repoId="default">
        <Probe />
      </BoardRefProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("ref").textContent).toBe("feat/new-board"));
    expect(window.location.search).toBe("?project=acme&ref=feat%2Fnew-board");
  });

  it("ignores an invalid ?ref=", () => {
    window.history.replaceState(null, "", "/r/default/?ref=..%2Fmain");
    render(
      <BoardRefProvider repoId="default">
        <Probe />
      </BoardRefProvider>,
    );
    expect(screen.getByTestId("ref").textContent).toBe("merged");
  });

  it("adds ?ref= to read calls, but not to the branch list, refresh or submit", () => {
    setActiveRef("default", "feat/x");
    expect(repoApi("default", "/board")).toBe("/api/repos/default/board?ref=feat%2Fx");
    expect(repoApi("default", "/initiatives/a/history?skip=20")).toBe(
      "/api/repos/default/initiatives/a/history?skip=20&ref=feat%2Fx",
    );
    expect(repoApi("default", "/branches")).toBe("/api/repos/default/branches");
    expect(repoApi("default", "/edits/submit")).toBe("/api/repos/default/edits/submit");
    expect(repoApi("default", "/refresh")).toBe("/api/repos/default/refresh");
    expect(repoApi("other", "/board")).toBe("/api/repos/other/board");
  });

  it("RepoProvider remounts the page on a branch change", async () => {
    installBranches();
    let mounts = 0;
    function Counter() {
      mounts += 1;
      return null;
    }
    const user = userEvent.setup();
    render(
      <RepoProvider repoId="default">
        <BranchPicker now={NOW} />
        <Counter />
      </RepoProvider>,
    );
    const before = mounts;
    await user.click(screen.getAllByTestId("branch-chip")[0]!);
    await user.click(await screen.findByText("docs/readme"));
    expect(mounts).toBeGreaterThan(before);
  });
});

describe("basket per branch", () => {
  it("keeps one basket per branch under snoboard:basket:v1:<repo>:<branch>", () => {
    const main = renderHook(() => useBasket("default"), {
      wrapper: ({ children }) => <BoardRefProvider repoId="default">{children}</BoardRefProvider>,
    });
    act(() => main.result.current.add(EDIT));
    expect(localStorage.getItem(basketStorageKey("default", "main"))).toBe(JSON.stringify([EDIT]));
    main.unmount();
    window.history.replaceState(null, "", "/?ref=feat%2Fx");
    const feature = renderHook(() => useBasket("default"), {
      wrapper: ({ children }) => <BoardRefProvider repoId="default">{children}</BoardRefProvider>,
    });
    expect(feature.result.current.edits).toEqual([]);
    act(() => feature.result.current.add({ ...EDIT, to: "done" }));
    expect(JSON.parse(localStorage.getItem(basketStorageKey("default", "feat/x")) ?? "[]")).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(basketStorageKey("default", "main")) ?? "[]")).toEqual([EDIT]);
  });

  it("moves the pre-branch basket to the default branch once", () => {
    localStorage.setItem(legacyBasketStorageKey("default"), JSON.stringify([EDIT]));
    const { result } = renderHook(() => useBasket("default"), {
      wrapper: ({ children }) => <BoardRefProvider repoId="default">{children}</BoardRefProvider>,
    });
    expect(result.current.edits).toEqual([EDIT]);
    expect(localStorage.getItem(legacyBasketStorageKey("default"))).toBeNull();
    expect(localStorage.getItem(basketStorageKey("default", "main"))).toBe(JSON.stringify([EDIT]));
  });

  it("does not move the old basket onto another branch", () => {
    localStorage.setItem(legacyBasketStorageKey("default"), JSON.stringify([EDIT]));
    window.history.replaceState(null, "", "/?ref=feat%2Fx");
    const { result } = renderHook(() => useBasket("default"), {
      wrapper: ({ children }) => <BoardRefProvider repoId="default">{children}</BoardRefProvider>,
    });
    expect(result.current.edits).toEqual([]);
    expect(localStorage.getItem(legacyBasketStorageKey("default"))).not.toBeNull();
  });
});
