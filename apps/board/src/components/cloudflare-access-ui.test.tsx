// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionActions } from "@/components/session-actions";
import { Page as LoginPage } from "../../pages/login/+Page";

let pathname = "/";
let pageData: { password: boolean; github: boolean; cloudflareAccess: boolean } = {
  password: false,
  github: false,
  cloudflareAccess: true,
};

vi.mock("vike-react/usePageContext", () => ({
  usePageContext: () => ({ urlPathname: pathname }),
}));

vi.mock("vike-react/useData", () => ({
  useData: () => pageData,
}));

afterEach(() => {
  cleanup();
  pathname = "/";
  pageData = { password: false, github: false, cloudflareAccess: true };
  vi.unstubAllGlobals();
});

describe("cloudflare access UI", () => {
  it("shows an Access message instead of a password or GitHub sign-in", () => {
    pageData = { password: true, github: true, cloudflareAccess: true };
    render(<LoginPage />);

    expect(screen.getByText("Sign-in is handled by Cloudflare Access")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open the board" }).getAttribute("href")).toBe("/");
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Sign in with GitHub" })).toBeNull();
  });

  it("shows the signed-in email and a Cloudflare sign-out link", async () => {
    pathname = "/";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ email: "ada@example.com" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    render(<SessionActions />);

    expect(await screen.findByText("ada@example.com")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign out" }).getAttribute("href")).toBe("/cdn-cgi/access/logout");
    expect(screen.queryByRole("button", { name: "Log out" })).toBeNull();
    expect(screen.queryByLabelText("Password")).toBeNull();
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/session");
    const body = JSON.stringify(fetchMock.mock.calls);
    expect(body).not.toContain("assertion");
  });
});
