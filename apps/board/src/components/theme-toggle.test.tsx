// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeToggle } from "@/components/theme-toggle";
import { THEME_STORAGE_KEY } from "@/lib/theme";

type Listener = (event: MediaQueryListEvent) => void;

function installMatchMedia(matches: boolean) {
  const listeners = new Set<Listener>();
  const media = {
    matches,
    media: "(prefers-color-scheme: dark)",
    addEventListener(_type: string, listener: Listener) {
      listeners.add(listener);
    },
    removeEventListener(_type: string, listener: Listener) {
      listeners.delete(listener);
    },
    setMatches(next: boolean) {
      media.matches = next;
      for (const listener of listeners) listener({ matches: next } as MediaQueryListEvent);
    },
  };
  vi.stubGlobal("matchMedia", vi.fn(() => media));
  return media;
}

let media: ReturnType<typeof installMatchMedia>;

beforeEach(() => {
  media = installMatchMedia(false);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  document.documentElement.style.colorScheme = "";
  vi.unstubAllGlobals();
});

describe("theme control", () => {
  it("defaults to system and follows prefers-color-scheme live", () => {
    render(<ThemeToggle />);

    const system = screen.getByRole("radio", { name: "System" });
    expect(system.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Light" }).getAttribute("aria-checked")).toBe("false");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(system.querySelector("span")?.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["hidden", "sm:inline"]),
    );

    media.setMatches(true);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe("dark");

    media.setMatches(false);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("persists light and dark and ignores OS changes until system is chosen", async () => {
    const user = userEvent.setup();
    media.setMatches(true);
    render(<ThemeToggle />);
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    await user.click(screen.getByRole("radio", { name: "Light" }));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(screen.getByRole("radio", { name: "Light" }).getAttribute("aria-checked")).toBe("true");

    media.setMatches(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    await user.click(screen.getByRole("radio", { name: "Dark" }));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    media.setMatches(false);
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    await user.click(screen.getByRole("radio", { name: "System" }));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    media.setMatches(true);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("restores the stored mode before paint", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    render(<ThemeToggle />);
    expect(screen.getByRole("radio", { name: "Dark" }).getAttribute("aria-checked")).toBe("true");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});
