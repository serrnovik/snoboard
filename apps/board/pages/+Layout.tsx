import type { ReactNode } from "react";
import { AppChrome } from "@/components/app-chrome";
import { TooltipProvider } from "@/components/ui/tooltip";
import "../src/styles.css";

export function Layout({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider>
      <AppChrome>{children}</AppChrome>
    </TooltipProvider>
  );
}
