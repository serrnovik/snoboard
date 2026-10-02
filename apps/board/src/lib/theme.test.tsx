// @vitest-environment jsdom

import { cleanup } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Head } from "../../pages/+Head";
import {
  THEME_STORAGE_KEY,
  applyDocumentTheme,
  parseThemeMode,
  resolveDark,
  themeBootScript,
  type ThemeMode,
} from "@/lib/theme";

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  document.documentElement.style.colorScheme = "";
  vi.unstubAllGlobals();
});

describe("theme resolution", () => {
  it("defaults unknown values to system", () => {
    expect(parseThemeMode(null)).toBe("system");
    expect(parseThemeMode(undefined)).toBe("system");
    expect(parseThemeMode("")).toBe("system");
    expect(parseThemeMode("nope")).toBe("system");
    expect(parseThemeMode("light")).toBe("light");
    expect(parseThemeMode("dark")).toBe("dark");
    expect(parseThemeMode("system")).toBe("system");
  });

  it("resolves system from the OS preference and pins light and dark", () => {
    expect(resolveDark("system", false)).toBe(false);
    expect(resolveDark("system", true)).toBe(true);
    expect(resolveDark("light", true)).toBe(false);
    expect(resolveDark("dark", false)).toBe(true);
  });

  it("applies the dark class and color scheme on the document", () => {
    expect(applyDocumentTheme("dark", false)).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe("dark");
    applyDocumentTheme("light", true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it.each<[string | null, boolean]>([
    ["light", false],
    ["light", true],
    ["dark", false],
    ["dark", true],
    ["system", false],
    ["system", true],
    ["nope", true],
    [null, false],
  ])("boot script matches resolution for %s when prefers-dark is %s", (stored, prefersDark) => {
    if (stored !== null) localStorage.setItem(THEME_STORAGE_KEY, stored);
    vi.stubGlobal("matchMedia", () => ({ matches: prefersDark, media: "(prefers-color-scheme: dark)" }));
    new Function(themeBootScript)();
    const mode: ThemeMode = parseThemeMode(stored);
    const dark = resolveDark(mode, prefersDark);
    expect(document.documentElement.classList.contains("dark")).toBe(dark);
    expect(document.documentElement.style.colorScheme).toBe(dark ? "dark" : "light");
  });

  it("ignores storage failures in the boot script", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(() => new Function(themeBootScript)()).not.toThrow();
  });

  it("inlines the boot script for static head markup", () => {
    const html = renderToStaticMarkup(<Head />);
    expect(html).toContain("<script>");
    expect(html).toContain(THEME_STORAGE_KEY);
    expect(html).toContain("prefers-color-scheme: dark");
  });
});
