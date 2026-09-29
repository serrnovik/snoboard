// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { ThemeToggle } from "@/components/theme-toggle";

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark");
});

describe("theme toggle", () => {
  it("labels the theme switch from the dark class", async () => {
    const user = userEvent.setup();
    document.documentElement.classList.add("dark");
    render(<ThemeToggle />);

    const toggle = screen.getByRole("switch", { name: "Dark mode" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("button", { name: "Switch to light mode" }).className).toContain("sm:hidden");
    expect(screen.getByText("Dark")).toBeTruthy();
    expect(screen.queryByText("Light")).toBeNull();

    await user.click(toggle);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Light")).toBeTruthy();

    await user.click(toggle);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(screen.getByText("Dark")).toBeTruthy();
  });
});
