import { Copy, KeyRound } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createToken, listTokens, revokeToken, useAgentBridge, type AgentToken } from "./bridge";
import { mcpSnippets } from "./snippets";

type RepoOption = { id: string; name: string };

/** Settings → Agent access: personal MCP tokens and client setup snippets. */
export function AgentAccess() {
  const { config } = useAgentBridge();
  const [tokens, setTokens] = useState<AgentToken[]>([]);
  const [repos, setRepos] = useState<RepoOption[]>([]);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<string[]>([]);
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const available = config !== null && config.enabled && config.available;

  const refresh = useCallback(async () => {
    const result = await listTokens();
    if (typeof result === "string") setError(result);
    else setTokens(result);
  }, []);

  useEffect(() => {
    if (!available) return;
    void refresh();
    void fetch("/api/repos", { credentials: "same-origin" })
      .then((response) => (response.ok ? response.json() : []))
      .then((body: unknown) => {
        if (!Array.isArray(body)) return;
        setRepos(
          body.flatMap((entry: unknown) =>
            typeof entry === "object" && entry !== null && typeof (entry as RepoOption).id === "string"
              ? [{ id: (entry as RepoOption).id, name: String((entry as RepoOption).name ?? (entry as RepoOption).id) }]
              : [],
          ),
        );
      })
      .catch(() => undefined);
  }, [available, refresh]);

  if (config === null) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!config.enabled) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="agent-access-off">
        Agent access is not enabled on this board (SNOBOARD_AGENT_BRIDGE).
      </p>
    );
  }
  if (!config.available) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="agent-access-unavailable">
        Agent access needs a personal sign-in (GitHub or Cloudflare Access). This sign-in is shared.
      </p>
    );
  }

  const create = async () => {
    setBusy(true);
    setError(null);
    const result = await createToken(name.trim(), scope);
    setBusy(false);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setCreated({ name: name.trim(), token: result.token });
    setName("");
    setScope([]);
    await refresh();
  };

  const revoke = async (token: AgentToken) => {
    setBusy(true);
    const failure = await revokeToken(token.id);
    setBusy(false);
    setError(failure);
    await refresh();
  };

  const url = config.mcpUrl ?? `${window.location.origin}/mcp`;
  return (
    <div className="flex flex-col gap-6" data-testid="agent-access">
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Agent access</h2>
        <p className="text-sm text-muted-foreground">
          Let your own coding agent (Claude Code, Codex, ...) on your machine read the board and propose edits. Proposals land in
          your inbox; nothing is committed until you accept them and submit your basket. The MCP endpoint is{" "}
          <code className="font-mono">{url}</code>.
        </p>
      </section>

      {error !== null ? (
        <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
          {error}
        </p>
      ) : null}

      {created !== null ? (
        <section className="flex flex-col gap-3 rounded-lg border border-amber-500/50 bg-amber-500/5 p-3" data-testid="token-created">
          <p className="text-sm font-medium">Token “{created.name}” created. Copy it now: it is not shown again.</p>
          <CopyBlock label="Token" text={created.token} testId="token-value" />
          {mcpSnippets(url, created.token).map((snippet) => (
            <CopyBlock key={snippet.id} label={snippet.label} text={snippet.text} testId={`snippet-${snippet.id}`} />
          ))}
          <div>
            <Button type="button" variant="outline" size="sm" onClick={() => setCreated(null)}>
              Done
            </Button>
          </div>
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">New token</h3>
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim().length > 0) void create();
          }}
        >
          <label className="flex flex-col gap-1 text-sm">
            Name
            <Input
              value={name}
              maxLength={64}
              placeholder="laptop claude code"
              data-testid="token-name"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {repos.length > 1 ? (
            <fieldset className="flex flex-wrap gap-3 text-sm">
              <legend className="mb-1 text-muted-foreground">Repositories (none checked: all)</legend>
              {repos.map((repo) => (
                <label key={repo.id} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={scope.includes(repo.id)}
                    onChange={(event) =>
                      setScope(event.target.checked ? [...scope, repo.id] : scope.filter((entry) => entry !== repo.id))
                    }
                  />
                  {repo.name}
                </label>
              ))}
            </fieldset>
          ) : null}
          <div>
            <Button type="submit" size="sm" disabled={busy || name.trim().length === 0} data-testid="token-create">
              <KeyRound aria-hidden="true" />
              Create token
            </Button>
          </div>
        </form>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Your tokens</h3>
        {tokens.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tokens yet.</p>
        ) : (
          <ul className="flex flex-col gap-1" data-testid="token-list">
            {tokens.map((token) => (
              <li key={token.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="font-medium">{token.name}</span>{" "}
                  <span className="text-muted-foreground">
                    · {token.repos === null ? "all repositories" : token.repos.join(", ")} · created {token.created.slice(0, 10)}
                    {token.lastUsed !== null ? ` · last used ${token.lastUsed.slice(0, 16).replace("T", " ")}` : " · never used"}
                  </span>
                </span>
                {token.revoked !== null ? (
                  <span className="text-xs text-muted-foreground">revoked</span>
                ) : (
                  <Button type="button" variant="destructive" size="xs" disabled={busy} onClick={() => void revoke(token)} aria-label={`Revoke ${token.name}`}>
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function CopyBlock({ label, text, testId }: { label: string; text: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={() => {
            void navigator.clipboard.writeText(text).then(
              () => setCopied(true),
              () => setCopied(false),
            );
          }}
        >
          <Copy aria-hidden="true" />
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="overflow-x-auto rounded-md border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap break-all" data-testid={testId}>
        {text}
      </pre>
    </div>
  );
}
