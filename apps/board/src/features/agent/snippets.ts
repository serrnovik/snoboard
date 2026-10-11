/** MCP client setup for a personal token. The token appears only in what the person copies. */
export type McpSnippet = { id: "claude" | "codex" | "json"; label: string; text: string };

export const TOKEN_ENV = "SNOBOARD_MCP_TOKEN";

export function mcpSnippets(url: string, token: string): McpSnippet[] {
  return [
    {
      id: "claude",
      label: "Claude Code",
      text: `claude mcp add --transport http snoboard ${url} --header "Authorization: Bearer ${token}"`,
    },
    {
      id: "codex",
      label: "Codex (~/.codex/config.toml)",
      text: [
        `# export ${TOKEN_ENV}=${token}`,
        "[mcp_servers.snoboard]",
        `url = "${url}"`,
        `bearer_token_env_var = "${TOKEN_ENV}"`,
      ].join("\n"),
    },
    {
      id: "json",
      label: "Other clients (mcp.json)",
      text: JSON.stringify(
        { mcpServers: { snoboard: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } },
        null,
        2,
      ),
    },
  ];
}
