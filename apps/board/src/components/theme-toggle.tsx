import { Monitor, Moon, Sun } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import { useIsomorphicLayoutEffect } from "@/hooks/use-isomorphic-layout-effect";
import {
  THEME_MODES,
  THEME_STORAGE_KEY,
  applyDocumentTheme,
  parseThemeMode,
  readPrefersDark,
  type ThemeMode,
} from "@/lib/theme";

const OPTIONS: readonly { mode: ThemeMode; label: string; icon: typeof Sun }[] = [
  { mode: "system", label: "System", icon: Monitor },
  { mode: "light", label: "Light", icon: Sun },
  { mode: "dark", label: "Dark", icon: Moon },
];

export function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>("system");

  useIsomorphicLayoutEffect(() => {
    const storedMode = () => parseThemeMode(localStorage.getItem(THEME_STORAGE_KEY));
    if (typeof window.matchMedia !== "function") {
      applyDocumentTheme(storedMode(), false);
      setMode(storedMode());
      return;
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const current = storedMode();
      applyDocumentTheme(current, media.matches);
      setMode(current);
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  function choose(next: ThemeMode) {
    localStorage.setItem(THEME_STORAGE_KEY, next);
    applyDocumentTheme(next, readPrefersDark());
    setMode(next);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const current = THEME_MODES.indexOf(mode);
    let nextIndex = current;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (current + 1) % THEME_MODES.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (current - 1 + THEME_MODES.length) % THEME_MODES.length;
    } else return;
    event.preventDefault();
    const next = THEME_MODES[nextIndex];
    if (next === undefined) return;
    choose(next);
    event.currentTarget.querySelector<HTMLButtonElement>(`button[data-theme="${next}"]`)?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="inline-flex shrink-0 items-center rounded-md border border-border bg-background p-0.5"
      onKeyDown={onKeyDown}
    >
      {OPTIONS.map((option) => {
        const selected = mode === option.mode;
        const Icon = option.icon;
        return (
          <button
            key={option.mode}
            type="button"
            role="radio"
            data-theme={option.mode}
            aria-checked={selected}
            aria-label={option.label}
            tabIndex={selected ? 0 : -1}
            className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-muted-foreground hover:text-foreground aria-checked:bg-muted aria-checked:text-foreground"
            onClick={() => choose(option.mode)}
          >
            <Icon aria-hidden="true" className="size-3.5" />
            <span className="hidden sm:inline" aria-hidden="true">
              {option.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
