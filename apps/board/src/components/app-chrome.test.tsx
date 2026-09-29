// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppChrome } from "@/components/app-chrome";
import { PageActionsPortal } from "@/components/page-actions";
import { Page as LoginPage } from "../../pages/login/+Page";

let pathname = "/";

vi.mock("vike-react/usePageContext", () => ({
  usePageContext: () => ({ urlPathname: pathname }),
}));

vi.mock("vike-react/useData", () => ({
  useData: () => ({ password: true, github: false }),
}));

afterEach(() => {
  cleanup();
  pathname = "/";
  document.documentElement.classList.remove("dark");
});

describe("app chrome", () => {
  it("keeps nav links left and page actions, theme, and log out on the right", async () => {
    pathname = "/graph";
    render(
      <AppChrome>
        <PageActionsPortal>
          <button type="button">Refresh</button>
        </PageActionsPortal>
      </AppChrome>,
    );

    expect(await screen.findByRole("button", { name: "Refresh" })).toBeTruthy();
    const header = screen.getByRole("banner");
    expect(header.className.includes("justify-between")).toBe(false);
    expect(header.className.includes("absolute")).toBe(false);
    const spacer = header.querySelector(":scope > .flex-1");
    expect(spacer).toBeTruthy();

    const text = header.textContent ?? "";
    const board = text.indexOf("Board");
    const refresh = text.indexOf("Refresh");
    const theme = text.indexOf("Light");
    const logout = text.indexOf("Log out");
    expect(board).toBeGreaterThanOrEqual(0);
    expect(refresh).toBeGreaterThan(board);
    expect(theme).toBeGreaterThan(refresh);
    expect(logout).toBeGreaterThan(theme);
    const logoutButton = screen.getByRole("button", { name: "Log out" });
    const followsSpacer =
      spacer !== null && (spacer.compareDocumentPosition(logoutButton) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(followsSpacer).toBe(true);
  });

  it("does not render a page refresh until the page provides one", () => {
    pathname = "/";
    render(
      <AppChrome>
        <p>Board page</p>
      </AppChrome>,
    );
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
    expect(screen.getByRole("button", { name: "Log out" })).toBeTruthy();
    const text = screen.getByRole("banner").textContent ?? "";
    expect(text.indexOf("Log out")).toBeGreaterThan(text.indexOf("Light"));
  });

  it("stacks header actions under the nav below the sm breakpoint", () => {
    render(
      <AppChrome>
        <p>Board page</p>
      </AppChrome>,
    );

    const header = screen.getByRole("banner");
    const headerClasses = header.className.split(/\s+/);
    expect(headerClasses).toContain("flex-col");
    expect(headerClasses).toContain("sm:flex-row");
    expect(headerClasses).toContain("sm:h-12");
    expect(headerClasses).not.toContain("h-12");

    const children = [...header.children];
    expect(children).toHaveLength(3);
    expect(children[0]?.textContent).toContain("Dependencies");
    expect(children[1]?.className.split(/\s+/)).toEqual(expect.arrayContaining(["hidden", "flex-1", "sm:block"]));
    expect(children[2]?.className.split(/\s+/)).toEqual(expect.arrayContaining(["flex", "min-h-12"]));
    expect(children[2]?.textContent).toContain("Log out");

    const themeButton = screen.getByRole("button", { name: "Switch to dark mode" });
    expect(themeButton.className.split(/\s+/)).toContain("sm:hidden");
    const wideTheme = screen.getByText("Light").parentElement;
    expect(wideTheme?.className.split(/\s+/)).toEqual(expect.arrayContaining(["hidden", "sm:flex"]));

    const logout = screen.getByRole("button", { name: "Log out" });
    expect(logout.querySelector("svg")).toBeTruthy();
    expect(logout.querySelector("span")?.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["hidden", "sm:inline"]),
    );
  });

  it("keeps only the app name and theme toggle on the login page", () => {
    pathname = "/login";
    render(
      <AppChrome>
        <LoginPage />
      </AppChrome>,
    );

    expect(screen.getByRole("link", { name: "Snoboard" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Dark mode" })).toBeTruthy();
    expect(screen.getAllByRole("switch", { name: "Dark mode" })).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "Snoboard" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Board" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Dependencies" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Log out" })).toBeNull();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  });
});
