import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useBasketBranch } from "@/features/repo/branch-context";
import { useAgentBridge } from "./bridge";
import { buildAgentPrompt, type PromptTarget } from "./prompt";

/** Copies a prompt for the person's own coding agent. Shown only when the agent bridge is on for them. */
export function CopyPromptButton({
  target,
  label = "Copy prompt for agent",
  compact = false,
  testId = "copy-agent-prompt",
  className,
}: {
  target: Omit<PromptTarget, "branch" | "mcp">;
  label?: string;
  compact?: boolean;
  testId?: string;
  className?: string;
}) {
  const { branch } = useBasketBranch();
  const { config } = useAgentBridge();
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const mcp = config !== null && config.enabled && config.available;
  if (!mcp) return null;
  const copy = async () => {
    const text = buildAgentPrompt({ ...target, branch, mcp });
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    window.setTimeout(() => setState("idle"), 2000);
  };
  const text = state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label;
  return (
    <Button
      type="button"
      variant="outline"
      size={compact ? "xs" : "sm"}
      data-testid={testId}
      aria-label={compact ? label : undefined}
      title={label}
      {...(className === undefined ? {} : { className })}
      onClick={() => void copy()}
    >
      {state === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {compact ? <span className="sr-only">{text}</span> : text}
    </Button>
  );
}
