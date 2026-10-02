#!/usr/bin/env node
// Creates a bare git repository with neutral demo initiatives on main and on
// initiative/* branches, for screenshots, local tries and end-to-end tests.
//
//   node examples/make-demo-remote.mjs <target-dir>      # default: ./snoboard-demo.git
//   SNOBOARD_REPO_URL=file:///abs/path/snoboard-demo.git
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const target = path.resolve(process.argv[2] ?? "snoboard-demo.git");
const work = mkdtempSync(path.join(os.tmpdir(), "snoboard-demo-src-"));

function git(args, env = {}) {
  execFileSync("git", args, { cwd: work, stdio: "pipe", env: { ...process.env, ...env } });
}

function commit(message, date) {
  git(["add", "-A"]);
  git(["commit", "-q", "-m", message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
}

function initiative(folder, fields, summary) {
  const dir = path.join(work, "initiatives", folder);
  mkdirSync(dir, { recursive: true });
  const lines = [
    "---",
    `id: ${fields.id}`,
    `title: ${fields.title}`,
    `status: ${fields.status}`,
    `priority: ${fields.priority}`,
    `depends_on: [${(fields.depends ?? []).join(", ")}]`,
    `branch: initiative/${fields.id}`,
    `updated: ${fields.updated}`,
    `labels: [${(fields.labels ?? []).join(", ")}]`,
  ];
  if (fields.issues) {
    lines.push("issues:");
    for (const ref of fields.issues) lines.push(`  - ${ref}`);
  }
  if (fields.phases) {
    lines.push("phases:");
    for (const phase of fields.phases) {
      lines.push(`  - id: ${phase.id}`, `    title: ${phase.title}`, `    status: ${phase.status}`);
      if (phase.pr) lines.push(`    pr: ${phase.pr}`);
      if (phase.depends) lines.push(`    depends_on: [${phase.depends.join(", ")}]`);
    }
  }
  if (fields.links) {
    lines.push("links:");
    for (const link of fields.links) lines.push(`  - title: ${link.title}`, `    url: ${link.url}`);
  }
  lines.push("---", "", `# ${fields.title}`, "", "## Summary", "", summary, "");
  if (fields.body) lines.push(fields.body.trim(), "");
  writeFileSync(path.join(dir, "initiative.md"), lines.join("\n"));
}

rmSync(target, { recursive: true, force: true });
git(["init", "-q", "-b", "main"]);
git(["config", "user.email", "demo@example.com"]);
git(["config", "user.name", "Snoboard Demo"]);
git(["config", "core.autocrlf", "false"]);
git(["config", "commit.gpgsign", "false"]);

initiative("acme/001-onboarding", {
  id: "acme-001", title: "Customer onboarding flow", status: "done", priority: "p1",
  updated: "2026-09-24", labels: ["web"],
  phases: [
    { id: 1, title: "Sign-up", status: "done", pr: 12 },
    { id: 2, title: "First dashboard", status: "done", pr: 15 },
  ],
}, "New customers can sign up and reach their first dashboard in under two minutes.");
initiative("acme/002-billing", {
  id: "acme-002", title: "Usage-based billing", status: "in-progress", priority: "p0",
  depends: ["acme-001"], updated: "2026-09-27", labels: ["billing"],
  issues: ["gh#18", "gh#23"],
  links: [
    { title: "Pricing design doc", url: "https://example.com/docs/pricing" },
    { title: "Billing dashboard", url: "https://example.com/dashboards/billing" },
  ],
  phases: [
    { id: 1, title: "Metering", status: "done", pr: 21 },
    { id: 2, title: "Invoices", status: "in-progress", depends: [1] },
    { id: 3, title: "Dunning", status: "planned", depends: [2] },
  ],
  body: `
## Goals

- Meter active seats per day.
- Monthly invoices with line items, downloadable as PDF.
- Retry failed payments and notify the account owner.

## Out of scope

Annual plans and coupons.
`,
}, "Customers are charged per active seat, with invoices in the account area.");
initiative("acme/003-reports", {
  id: "acme-003", title: "Monthly usage reports", status: "planned", priority: "p2",
  depends: ["acme-002"], updated: "2026-09-20", labels: ["reports"],
  issues: ["gh#12", "gh:acme/widgets#45", "vikunja:34"],
}, "Account owners get a monthly email summarising usage and cost.");
initiative("acme/004-search", {
  id: "acme-004", title: "Global search", status: "idea", priority: "p3",
  updated: "2026-09-15", labels: ["web"],
  links: [{ title: "Search prototype notes", url: "https://example.com/notes/search" }],
}, "One search box across projects, people and documents.");
initiative("platform/001-ci", {
  id: "platform-001", title: "Faster CI pipelines", status: "review", priority: "p1",
  updated: "2026-09-28", labels: ["infra"], issues: ["gh#31"],
  phases: [
    { id: 1, title: "Cache dependencies", status: "done", pr: 30 },
    { id: 2, title: "Split test shards", status: "review", pr: 33 },
  ],
}, "Pull request checks finish in under five minutes.");
initiative("platform/002-observability", {
  id: "platform-002", title: "Service observability", status: "planned", priority: "p1",
  depends: ["platform-001"], updated: "2026-09-22", labels: ["infra", "security"],
  links: [{ title: "Tracing RFC", url: "https://example.com/rfc/tracing" }],
}, "Every service ships traces and a health dashboard.");
initiative("platform/003-sso", {
  id: "platform-003", title: "Single sign-on", status: "parked", priority: "p2",
  updated: "2026-08-01", labels: ["security"],
}, "Staff sign in once with the company identity provider.");
mkdirSync(path.join(work, "initiatives/platform/000-legacy-notes"), { recursive: true });
writeFileSync(
  path.join(work, "initiatives/platform/000-legacy-notes/initiative.md"),
  "# Initiative: Old migration notes\n\n## Summary\n\nA legacy folder without frontmatter.\n",
);
// Reports: a markdown report with its self-contained HTML twin, and one phase report.
const reports = path.join(work, "initiatives/acme/002-billing/reports");
mkdirSync(reports, { recursive: true });
writeFileSync(path.join(reports, "final.report.md"), `# Billing rollout report

Status of usage-based billing after the metering phase. Details per phase:
[phase 1 report](./phase-1.report.md).

## Results

| Metric | Before | After |
| --- | --- | --- |
| Invoices sent on time | 82% | 99% |
| Manual billing fixes per month | 41 | 3 |
| Seat count drift | 6% | 0.4% |

## Decisions

- Meter seats once per day at 00:00 UTC.
- Invoices are generated on the first working day of the month.
- Failed payments retry after 1, 3 and 7 days.

## Next

1. Finish invoice PDFs (phase 2).
2. Start dunning emails (phase 3).
`);
writeFileSync(path.join(reports, "final.report.html"), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Billing rollout report</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; margin: 2rem; color: #1f2937; }
  h1 { font-size: 1.6rem; margin-bottom: .25rem; }
  .kpis { display: flex; gap: 1rem; margin: 1.5rem 0; }
  .kpi { flex: 1; border: 1px solid #e5e7eb; border-radius: 10px; padding: 1rem; }
  .kpi b { display: block; font-size: 1.8rem; color: #047857; }
  .bar { height: 10px; border-radius: 5px; background: #d1fae5; }
  .bar span { display: block; height: 100%; border-radius: 5px; background: #10b981; }
</style></head>
<body>
  <h1>Billing rollout report</h1>
  <p>Usage-based billing after the metering phase.</p>
  <div class="kpis">
    <div class="kpi"><b>99%</b>invoices on time</div>
    <div class="kpi"><b>3</b>manual fixes per month</div>
    <div class="kpi"><b>0.4%</b>seat count drift</div>
  </div>
  <p>Rollout progress</p>
  <div class="bar"><span style="width: 45%"></span></div>
</body></html>
`);
writeFileSync(path.join(reports, "phase-1.report.md"), `# Phase 1: Metering

Seats are metered daily per workspace. Back to the [final report](final.report.md).

- Active seat = signed in during the day.
- Counts are stored per day and summed per invoice period.
`);
commit("Demo initiatives", "2026-09-28T09:00:00Z");

// A branch that moves acme-003 forward after main last touched it.
git(["checkout", "-q", "-b", "initiative/acme-003-reports"]);
initiative("acme/003-reports", {
  id: "acme-003", title: "Monthly usage reports", status: "in-progress", priority: "p2",
  depends: ["acme-002"], updated: "2026-09-29", labels: ["reports"],
  issues: ["gh#12", "gh:acme/widgets#45", "vikunja:34"],
}, "Account owners get a monthly email summarising usage and cost.");
commit("Start monthly reports", "2026-09-29T10:00:00Z");

// A new initiative that exists only on its branch.
git(["checkout", "-q", "main"]);
git(["checkout", "-q", "-b", "initiative/platform-004-cost-dashboards"]);
initiative("platform/004-cost-dashboards", {
  id: "platform-004", title: "Cost dashboards", status: "in-progress", priority: "p2",
  depends: ["platform-002"], updated: "2026-09-29", labels: ["infra"],
}, "Engineers see the monthly cloud cost of each service.");
commit("Add cost dashboards", "2026-09-29T11:00:00Z");
git(["checkout", "-q", "main"]);

execFileSync("git", ["clone", "-q", "--bare", work, target], { stdio: "pipe" });
execFileSync("git", ["-C", target, "config", "uploadpack.allowFilter", "true"]);
execFileSync("git", ["-C", target, "config", "uploadpack.allowAnySHA1InWant", "true"]);
rmSync(work, { recursive: true, force: true });
console.log(`Demo remote ready: ${target}`);
console.log(`SNOBOARD_REPO_URL=file://${target.startsWith("/") ? "" : "/"}${target.replaceAll("\\", "/")}`);
