import { cn } from "cn";
import { Settings } from "lucide-react";
import { useEffect } from "react";
import { buttonVariants } from "@/components/ui/button";
import { startAgentBridge, useAgentBridge } from "./bridge";
import { InboxButton } from "./Inbox";

/** Starts the agent bridge once per page (no-op when the server has it off) and shows the inbox and settings. */
export function AgentHeader({ repoId }: { repoId: string | null }) {
  const { config } = useAgentBridge();
  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;
    void startAgentBridge().then((dispose) => {
      if (cancelled) dispose();
      else stop = dispose;
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);
  if (config === null || !config.enabled) return null;
  return (
    <>
      <InboxButton repoId={repoId} />
      <a
        href="/settings"
        aria-label="Settings: agent access"
        title="Agent access"
        data-testid="settings-link"
        className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }))}
      >
        <Settings aria-hidden="true" />
      </a>
    </>
  );
}
