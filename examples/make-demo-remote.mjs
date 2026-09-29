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
  if (fields.phases) {
    lines.push("phases:");
    for (const phase of fields.phases) {
      lines.push(`  - id: ${phase.id}`, `    title: ${phase.title}`, `    status: ${phase.status}`);
      if (phase.pr) lines.push(`    pr: ${phase.pr}`);
    }
  }
  lines.push("---", "", `# ${fields.title}`, "", "## Summary", "", summary, "");
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
  phases: [
    { id: 1, title: "Metering", status: "done", pr: 21 },
    { id: 2, title: "Invoices", status: "in-progress" },
    { id: 3, title: "Dunning", status: "planned" },
  ],
}, "Customers are charged per active seat, with invoices in the account area.");
initiative("acme/003-reports", {
  id: "acme-003", title: "Monthly usage reports", status: "planned", priority: "p2",
  depends: ["acme-002"], updated: "2026-09-20", labels: ["reports"],
}, "Account owners get a monthly email summarising usage and cost.");
initiative("acme/004-search", {
  id: "acme-004", title: "Global search", status: "idea", priority: "p3",
  updated: "2026-09-15", labels: ["web"],
}, "One search box across projects, people and documents.");
initiative("platform/001-ci", {
  id: "platform-001", title: "Faster CI pipelines", status: "review", priority: "p1",
  updated: "2026-09-28", labels: ["infra"],
}, "Pull request checks finish in under five minutes.");
initiative("platform/002-observability", {
  id: "platform-002", title: "Service observability", status: "planned", priority: "p1",
  depends: ["platform-001"], updated: "2026-09-22", labels: ["infra"],
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
commit("Demo initiatives", "2026-09-28T09:00:00Z");

// A branch that moves acme-003 forward after main last touched it.
git(["checkout", "-q", "-b", "initiative/acme-003-reports"]);
initiative("acme/003-reports", {
  id: "acme-003", title: "Monthly usage reports", status: "in-progress", priority: "p2",
  depends: ["acme-002"], updated: "2026-09-29", labels: ["reports"],
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
