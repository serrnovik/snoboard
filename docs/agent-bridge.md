# Agent bridge

The agent bridge lets each person connect their **own** coding agent (Claude Code, Codex, or any MCP client) on
their own machine to the board. The agent works in a local checkout of the repository; the board is where the
person reviews what it proposes. The board never calls a language model.

It is optional and off by default. With `SNOBOARD_AGENT_BRIDGE=true` the board adds:

- **Personal MCP tokens** (Settings → Agent access) and an MCP endpoint at `/mcp`.
- **Server-side baskets**: the browser basket syncs to the server per person, repository and branch, so agent
  proposals, other devices and the browser all meet in one basket. `localStorage` stays as the offline cache.
- **A proposal inbox**: agents propose edits; the person sees them in the header (**N proposals**), with a diff per
  edit, and accepts (into the basket) or rejects them. Nothing is committed until the person submits the basket as
  usual.
- **Live updates** (`GET /api/events`): new proposals, basket changes from another device or the inbox, and new
  snapshots (after a push and refresh) reach open boards at once.
- **Copy prompt for agent** on an initiative, on each phase row and on the basket.

## Turning it on

| Env var | Default | Meaning |
| --- | --- | --- |
| `SNOBOARD_AGENT_BRIDGE` | `false` | `true` turns the bridge on |
| `SNOBOARD_STATE_DIR` | `SNOBOARD_DATA_DIR` | Directory of `snoboard.db` (SQLite, WAL, mode `0600`). Mount a persistent volume here |
| `SNOBOARD_AGENT_BRIDGE_PASSWORD_USER` | `refuse` | `shared`: password sign-in uses one shared bridge user. Default: password users get no agent access |
| `SNOBOARD_AGENT_BRIDGE_MCP_URL` | `<SNOBOARD_PUBLIC_URL>/mcp` | URL shown in the setup snippets, when agents reach the board under another name (for example a tailnet host) |
| `SNOBOARD_AGENT_BRIDGE_ALLOWED_ORIGINS` | none | Comma-separated browser origins allowed to call `/mcp`. Agents send no `Origin`; leave empty |

The bridge needs a stable identity per person: GitHub sign-in (`github:<login>`) or Cloudflare Access
(`email:<address>`). Startup fails with `SNOBOARD_AUTH_MODES=none`, and with password-only sign-in unless
`SNOBOARD_AGENT_BRIDGE_PASSWORD_USER=shared` (everyone who knows the password then shares one inbox and basket).
With `password,github`, GitHub users get the bridge and password users do not.

Run one replica: the database file, rate limits and the event stream live in one process. Keep `snoboard.db` on a
persistent volume, or tokens, baskets and proposals are lost when the pod moves. The Helm chart has a `persistence`
block for this (see [deploy.md](deploy.md)).

## Connecting an agent

1. Open **Settings** (gear in the header) → **Agent access**, name a token (`laptop claude code`) and optionally limit
   it to some repositories. The token (`sbp_...`) is shown once; the server keeps only its SHA-256 hash.
2. Copy the snippet for your client:

   ```sh
   # Claude Code
   claude mcp add --transport http snoboard https://board.example.com/mcp --header "Authorization: Bearer sbp_..."
   ```

   ```toml
   # Codex: ~/.codex/config.toml, with SNOBOARD_MCP_TOKEN exported in your shell
   [mcp_servers.snoboard]
   url = "https://board.example.com/mcp"
   bearer_token_env_var = "SNOBOARD_MCP_TOKEN"
   ```

   Other clients take the JSON form (`{"mcpServers": {"snoboard": {"type": "http", "url": ..., "headers": {...}}}}`).
   Desktop apps that drive Claude Code or Codex use the same configuration.
3. On an initiative, a phase row or the basket, click **Copy prompt for agent**, replace the task placeholder, and
   paste it into the agent. The prompt names the repository id, branch, initiative id and file, and tells the agent
   which tools to use.
4. Revoke a token in the same page. Revoked tokens stop working at once.

## Two ways back to the board

- **Propose.** `propose_edits` (status, priority, title, labels, issues, links, phase status, body, documents, new
  initiatives) and `set_doc_from_local` (the whole text of a document the agent edited locally) check the edits
  against the branch with the same rules as the board's validate step and store a **proposal**. The person accepts
  it into their basket and submits it as a commit or pull request, exactly like their own edits.
- **Push.** The agent edits files, commits and pushes to the branch itself, then calls `notify_pushed`: the board
  fetches the repository now (instead of at the next `SNOBOARD_REFRESH_SECONDS`) and open boards reload.

## MCP tools

The endpoint speaks MCP over Streamable HTTP (`POST /mcp`, JSON responses; protocol versions `2025-06-18`,
`2025-03-26`, `2024-11-05`). `GET /mcp` answers `405`: there is no server-initiated stream.

| Tool | What it does |
| --- | --- |
| `list_repos` | Repositories the token may use, with the default branch and edit modes |
| `list_branches(repo, query?)` | Remote branches, newest first (at most 200) |
| `list_initiatives(repo, ref?, status?, project?, label?, query?, limit?)` | Initiatives of the merged board, or of one branch with `ref` |
| `get_initiative(repo, id, ref?)` | Parsed fields, raw frontmatter, body and `bodyHash`, documents and reports |
| `list_docs(repo, id, ref?)` / `read_doc(repo, id, path, ref?)` | Documents of the initiative; one document's text and sha256 |
| `get_basket(repo, branch)` | The person's pending edits for that branch |
| `propose_edits(repo, branch, edits, note?)` | Validate and store a proposal (see below) |
| `set_doc_from_local(repo, branch, id, path, content, note?)` | `setDoc` with the server's hash, or `createDoc` for a new `<name>.md` / `phases/<name>.md` |
| `list_proposals(repo?, status?)` | The person's proposals and their status |
| `notify_pushed(repo, branch)` | Fetch now and tell open boards; once per 30 s per token, repository and branch |

Edits use the board's edit format ([editing.md](editing.md)). Agents may leave out `from` and `fromHash`: the server
fills them from the snapshot of the target branch (the merged board for the default branch, as the browser does).
A given `from` / `fromHash` is kept, so an agent that read a document first still gets a stale check. A proposal is
stored only when every edit applies; otherwise nothing is stored and the per-edit results say why. Images cannot be
proposed (their bytes stay in the browser).

## REST and events (browser)

All need the board sign-in. Writes need the `Origin` check and the CSRF token from `GET /api/agent/config`.

| Route | Purpose |
| --- | --- |
| `GET /api/agent/config` | `{ enabled, available, user, mcpUrl, tools, csrf }` |
| `GET/POST /api/agent/tokens`, `DELETE /api/agent/tokens/<id>` | List, create (secret in this response only), revoke (`X-Snoboard-Csrf` header) |
| `GET/PUT /api/agent/basket` | Read or write a basket (`repo`, `branch`) |
| `GET /api/agent/proposals`, `POST .../<id>/accept`, `POST .../<id>/reject`, `POST .../accept-all` | The inbox |
| `GET /api/events` | Server-sent events: `proposal`, `basket`, `snapshot`; keep-alive every 25 s |

### Basket sync

Each browser keeps the version it last agreed with the server (`snoboard:basket-sync:v1:<repo>:<branch>`). A write
sends the whole local basket, the version it was based on (`baseUpdated`), and which edit keys it changed or
removed since then. When nobody wrote in between, the server stores it as is (last write wins). Otherwise it merges:
it starts from the stored basket, drops the keys this writer removed, and puts in the edits this writer changed.
An edit's key is what it changes (`setStatus:<id>`, `setPhaseStatus:<id>:<phase>`, `doc:<id>:<path>`, ...), so two
devices changing different things never lose each other's edits; the same thing changed on both keeps the later
write. A browser that changed nothing since its last sync simply adopts the server's basket. Offline edits stay in
`localStorage` and are merged on the next sync.

Image attachments sync as references only: the bytes stay in the browser that added them, so submit such a basket
from that browser.

## Limits

| What | Limit |
| --- | --- |
| Live tokens per person | 20 |
| MCP requests | 120 per token per minute |
| Proposals | 60 per token per hour, 50 edits and 192 KiB each, 200 pending per person |
| Tool results | 256 KiB (narrow the request when larger) |
| `/mcp` request body | 256 KiB |
| Synced basket | 512 KiB |
| Event streams | 10 per person, 200 per server |
| Decided proposals | kept 30 days |

The server logs one line per MCP call (`snoboard: mcp ok reason="ok" tool="propose_edits" user="github:ada"
token="<id>" repo="default" ms=12`) and per token creation and revocation; never a token, edit text or document
content. The threat model is in [SECURITY.md](../SECURITY.md#agent-bridge-snoboard_agent_bridgetrue).
