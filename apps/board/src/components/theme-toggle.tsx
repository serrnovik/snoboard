import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

function darkClassActive(): boolean {
  return typeof document !== "undefined" && document.documentElement.classList.contains("dark");
}

export function ThemeToggle() {
  const [dark, setDark] = useState(darkClassActive);

  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setDark(root.classList.contains("dark"));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  function onDarkChange(checked: boolean) {
    document.documentElement.classList.toggle("dark", checked);
    setDark(document.documentElement.classList.contains("dark"));
  }

  const mode = dark ? "Dark" : "Light";
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="sm:hidden"
        aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
        onClick={() => onDarkChange(!dark)}
      >
        {dark ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
      </Button>
      <div className="hidden items-center gap-2 text-sm sm:flex">
        <span>{mode}</span>
        <Switch checked={dark} onCheckedChange={onDarkChange} aria-label="Dark mode" />
      </div>
    </>
  );
}
