// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HistorySection } from "./History";
import { forgeCommitUrl, type ForgeLinkConfig } from "./links";
import { goBackInDetails, MAX_OPEN_STACK, openStack, setOpenId } from "./open";
import { Avatar, avatarUrl, initials, orderedPeople } from "@/features/people/People";

const forge: ForgeLinkConfig = {
  type: "github",
  repo: "acme/board",
  fileUrl: "https://github.com/{repo}/blob/{ref}/{path}",
  prUrl: "https://github.com/{repo}/pull/{pr}",
};

function sha(n: number): string {
  return n.toString(16).padStart(40, "a");
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("forgeCommitUrl", () => {
  it("builds https commit links from the PR template only", () => {
    expect(forgeCommitUrl(forge, sha(1))).toBe(`https://github.com/acme/board/commit/${sha(1)}`);
    expect(forgeCommitUrl({ ...forge, prUrl: "http://x/{repo}/pull/{pr}" }, sha(1))).toBeNull();
    expect(forgeCommitUrl({ ...forge, prUrl: "javascript:alert(1)//pull/{pr}" }, sha(1))).toBeNull();
    expect(forgeCommitUrl(forge, "not-a-sha")).toBeNull();
  });
});

describe("HistorySection", () => {
  it("lists commits newest first and pages with show more", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const skip = Number(new URL(url, "http://local").searchParams.get("skip"));
      const body =
        skip === 0
          ? { commits: [{ sha: sha(2), date: "2026-09-28T10:00:00Z", author: "Ann", subject: "move to done" }], hasMore: true }
          : { commits: [{ sha: sha(1), date: "2026-09-01T10:00:00Z", author: "Bob", subject: "create" }], hasMore: false };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<HistorySection id="acme-001" forge={forge} now={Date.parse("2026-09-29T10:00:00Z")} />);
    expect(await screen.findByText("move to done")).toBeTruthy();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/initiatives/acme-001/history?skip=0");
    const link = screen.getByRole("link", { name: sha(2).slice(0, 7) });
    expect(link.getAttribute("href")).toBe(`https://github.com/acme/board/commit/${sha(2)}`);
    expect(screen.getByText("1d ago").getAttribute("title")).toBe("2026-09-28T10:00:00Z");
    await user.click(screen.getByRole("button", { name: "Show more" }));
    expect(await screen.findByText("create")).toBeTruthy();
    expect(screen.getAllByTestId("history-commit")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("shows an error when the endpoint fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    render(<HistorySection id="acme-001" forge={forge} />);
    await waitFor(() => expect(screen.getByText("Could not load the history")).toBeTruthy());
  });
});

describe("details back stack", () => {
  it("pushes the previous initiative only when navigating from the details panel", () => {
    setOpenId("acme-001");
    expect(openStack()).toEqual([]);
    setOpenId("acme-002", { fromDetails: true });
    expect(openStack()).toEqual(["acme-001"]);
    setOpenId("acme-003", { fromDetails: true });
    expect(openStack()).toEqual(["acme-001", "acme-002"]);
    setOpenId(null);
    expect(openStack()).toEqual([]);
    expect(window.location.search).toBe("");
  });

  it("caps the stack and goes back through browser history", () => {
    setOpenId("acme-000");
    for (let index = 1; index <= MAX_OPEN_STACK + 5; index += 1) setOpenId(`acme-${String(index).padStart(3, "0")}`, { fromDetails: true });
    expect(openStack()).toHaveLength(MAX_OPEN_STACK);
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    goBackInDetails();
    expect(back).toHaveBeenCalledTimes(1);
  });
});

describe("people display", () => {
  it("uses GitHub avatars only for known logins, initials otherwise", () => {
    expect(avatarUrl({ login: "octo" })).toBe("https://github.com/octo.png?size=40");
    expect(avatarUrl({})).toBeNull();
    expect(avatarUrl({ login: "../evil" })).toBeNull();
    expect(initials("Ann Lee")).toBe("AL");
    expect(initials("bob")).toBe("BO");
    const { container } = render(<Avatar person={{ key: "email:a@x", name: "Ann Lee" }} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("AL");
  });

  it("puts the creator first without duplicating", () => {
    const creator = { key: "login:octo", name: "octo", login: "octo", date: "2026-01-01" };
    expect(
      orderedPeople({ creator, participants: [{ key: "email:a@x", name: "Ann" }, { key: "login:octo", name: "octo", login: "octo" }] }).map(
        (person) => person.name,
      ),
    ).toEqual(["octo", "Ann"]);
  });
});
