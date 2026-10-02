export const THEME_STORAGE_KEY = "snoboard-theme";

export const THEME_MODES = ["system", "light", "dark"] as const;

export type ThemeMode = (typeof THEME_MODES)[number];

export function parseThemeMode(value: string | null | undefined): ThemeMode {
  if (value === "light" || value === "dark" || value === "system") return value;
  return "system";
}

export function resolveDark(mode: ThemeMode, prefersDark: boolean): boolean {
  if (mode === "dark") return true;
  if (mode === "light") return false;
  return prefersDark;
}

export function readPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function applyDocumentTheme(mode: ThemeMode, prefersDark: boolean): boolean {
  const dark = resolveDark(mode, prefersDark);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  return dark;
}

export const themeBootScript = `(function(){try{var s=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});var m=s==="light"||s==="dark"||s==="system"?s:"system";var d=m==="dark"||(m!=="light"&&window.matchMedia("(prefers-color-scheme: dark)").matches);var root=document.documentElement;root.classList.toggle("dark",d);root.style.colorScheme=d?"dark":"light";}catch(e){}})();`;
