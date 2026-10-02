import { CircleDot, Hash, Link, ListTodo, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export type IssueView = {
  raw: string;
  url: string;
  title: string;
  state: "open" | "closed" | "unknown";
};

export function normalizeIssues(value: unknown): IssueView[] {
  if (!Array.isArray(value)) return [];
  const views: IssueView[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const raw = entry.trim();
      if (raw.length === 0) continue;
      views.push({ raw, url: "", title: "", state: "unknown" });
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.raw !== "string" || record.raw.length === 0) continue;
    const state =
      record.state === "open" || record.state === "closed" || record.state === "unknown" ? record.state : "unknown";
    views.push({
      raw: record.raw,
      url: typeof record.url === "string" ? record.url : "",
      title: typeof record.title === "string" ? record.title : "",
      state,
    });
  }
  return views;
}

function providerOf(raw: string): string {
  if (raw.startsWith("gh#") || raw.startsWith("gh:")) return "gh";
  const index = raw.indexOf(":");
  if (index <= 0) return "unknown";
  return raw.slice(0, index);
}

function providerIcon(provider: string): LucideIcon {
  if (provider === "gh") return Hash;
  if (provider === "vikunja" || provider === "vj") return ListTodo;
  return Link;
}

export function IssueCount({ issues }: { issues: unknown }) {
  // Same entries the details sheet shows.
  const count = normalizeIssues(issues).length;
  if (count === 0) return null;
  const label = count === 1 ? "1 issue" : `${count} issues`;
  return (
    <Badge variant="outline" data-testid="issue-count" aria-label={label} title={label}>
      <CircleDot aria-hidden="true" />
      {count}
    </Badge>
  );
}

export function IssueBadge({ issue }: { issue: IssueView }) {
  const provider = providerOf(issue.raw);
  const Icon = providerIcon(provider);
  const linked = issue.url.length > 0;
  const className = [
    "inline-flex max-w-full items-center gap-1.5 text-sm underline-offset-4",
    issue.state === "open" ? "text-emerald-800 dark:text-emerald-200" : "",
    issue.state === "closed" ? "text-muted-foreground" : "",
    issue.state === "unknown" ? "text-foreground" : "",
    linked ? "underline hover:underline" : "",
  ]
    .filter((part) => part.length > 0)
    .join(" ");
  const body = (
    <>
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="font-mono text-xs">{issue.raw}</span>
      {issue.title.length > 0 ? <span className="min-w-0 truncate">{issue.title}</span> : null}
      {issue.state === "open" || issue.state === "closed" ? <span className="text-xs">{issue.state}</span> : null}
    </>
  );
  if (!linked) {
    return (
      <span className={className} data-testid="issue-ref" data-state={issue.state} data-provider={provider}>
        {body}
      </span>
    );
  }
  return (
    <a
      className={className}
      href={issue.url}
      rel="noopener noreferrer"
      target="_blank"
      data-testid="issue-link"
      data-state={issue.state}
      data-provider={provider}
    >
      {body}
    </a>
  );
}
