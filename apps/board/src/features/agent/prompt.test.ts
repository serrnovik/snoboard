import { describe, expect, it } from "vitest";
import { buildAgentPrompt, TASK_PLACEHOLDER } from "./prompt";
import { mcpSnippets, TOKEN_ENV } from "./snippets";

describe("agent prompt", () => {
  it("names the repository, branch, initiative, phase and the MCP tools", () => {
    const text = buildAgentPrompt({
      repoId: "acme",
      branch: "feat/billing",
      initiative: { id: "acme-002", title: "Billing", path: "initiatives/acme/002-billing/initiative.md", status: "in-progress" },
      phase: { id: 1, title: "Invoices", status: "planned" },
      mcp: true,
    });
    expect(text.startsWith(`Task: ${TASK_PLACEHOLDER}`)).toBe(true);
    expect(text).toContain("- Repository id on the board: acme");
    expect(text).toContain("- Branch: feat/billing");
    expect(text).toContain("- Initiative: acme-002 — Billing (status: in-progress)");
    expect(text).toContain("- File: initiatives/acme/002-billing/initiative.md");
    expect(text).toContain("- Folder: initiatives/acme/002-billing/");
    expect(text).toContain("- Phase 1: Invoices (status: planned)");
    expect(text).toContain('call propose_edits (repo "acme", branch "feat/billing")');
    expect(text).toContain("set_doc_from_local");
    expect(text).toContain('notify_pushed (repo "acme", branch "feat/billing")');
    expect(text).toContain("git switch feat/billing");
  });

  it("lists the basket and works without MCP", () => {
    const text = buildAgentPrompt({ repoId: "default", branch: "main", basket: { count: 2, lines: ["acme-001 · A — idea → done", "acme-002 · B — body"] }, mcp: false });
    expect(text).toContain("- Pending edits in my basket: 2");
    expect(text).toContain("  - acme-002 · B — body");
    expect(text).not.toContain("propose_edits");
    expect(text).toContain("commit and push to main");
  });
});

describe("MCP setup snippets", () => {
  it("builds Claude Code, Codex and JSON configs", () => {
    const snippets = mcpSnippets("https://board.example.com/mcp", "sbp_secret");
    expect(snippets.map((snippet) => snippet.id)).toEqual(["claude", "codex", "json"]);
    expect(snippets[0]?.text).toBe(
      'claude mcp add --transport http snoboard https://board.example.com/mcp --header "Authorization: Bearer sbp_secret"',
    );
    expect(snippets[1]?.text).toContain(`bearer_token_env_var = "${TOKEN_ENV}"`);
    expect(JSON.parse(snippets[2]!.text)).toEqual({
      mcpServers: { snoboard: { type: "http", url: "https://board.example.com/mcp", headers: { Authorization: "Bearer sbp_secret" } } },
    });
  });
});
