import type { Context } from "hono";
import { Hono } from "hono";
import { bodyHash, summarizeEdit, VERSION, type BoardItem } from "snoboard";
import { z } from "zod";
import { branchSource } from "../branches.js";
import { MAX_VALIDATE_EDITS } from "../edits/prepare.js";
import { requestRefresh } from "../repo-sync.js";
import { editSettingsFor, listActiveRepos } from "../repos-config.js";
import { DEFAULT_REPO_ID, getConfig } from "../store.js";
import type { BridgeDb, TokenOwner } from "./db.js";
import { publishSnapshot } from "./events.js";
import {
  docEditFromLocal,
  MAX_NOTE_LENGTH,
  parseEdits,
  proposeEdits,
  readDocument,
  readInitiativeFile,
  splitInitiative,
  viewForBranch,
  viewForRef,
} from "./service.js";
import { agentBridgeSettings, bridgeDb, type BridgeUser } from "./settings.js";

/**
 * Model Context Protocol over Streamable HTTP (`POST /mcp`, JSON responses, no server-sent stream).
 * Implemented directly on JSON-RPC 2.0: the board only needs `initialize`, `ping`, `tools/list` and
 * `tools/call`, which is less code than wiring an SDK and adds no dependency.
 *
 * Auth is a personal token (`Authorization: Bearer sbp_...`), never a cookie. Requests that carry
 * an Origin header (browsers) are refused unless the origin is allowlisted.
 */

export const MCP_PATH = "/mcp";
export const MAX_MCP_BODY_BYTES = 256 * 1024;
export const MAX_TOOL_RESULT_BYTES = 256 * 1024;
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/** Requests per token per minute, all methods. */
export const MCP_REQUESTS_PER_MINUTE = 120;
/** propose_edits and set_doc_from_local per token per hour. */
export const MCP_PROPOSALS_PER_HOUR = 60;
/** notify_pushed: once per token, repository and branch in this window. */
export const NOTIFY_WINDOW_MS = 30_000;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const requestStamps = new Map<string, number[]>();
const proposalStamps = new Map<string, number[]>();
const notifyStamps = new Map<string, number>();

export function resetMcpLimits(): void {
  requestStamps.clear();
  proposalStamps.clear();
  notifyStamps.clear();
}

function allow(map: Map<string, number[]>, key: string, limit: number, windowMs: number, now: number): boolean {
  const recent = (map.get(key) ?? []).filter((stamp) => now - stamp < windowMs);
  if (recent.length >= limit) {
    map.set(key, recent);
    return false;
  }
  recent.push(now);
  map.set(key, recent);
  return true;
}

type JsonRpcId = string | number | null;
type JsonRpcRequest = { jsonrpc: "2.0"; id?: JsonRpcId; method: string; params?: unknown };

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const RATE_LIMITED = -32000;

function rpcError(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

function rpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

export const mcpRouter = new Hono();

mcpRouter.all(MCP_PATH, async (c) => {
  const settings = agentBridgeSettings();
  const db = bridgeDb();
  if (settings === null || db === null) return c.json({ error: "not found" }, 404);
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  const origin = c.req.header("origin");
  if (origin !== undefined && origin.length > 0 && !settings.allowedOrigins.includes(origin)) {
    logMcp({ outcome: "denied", reason: "origin" });
    return c.json({ error: "browser requests are not accepted here" }, 403);
  }
  const owner = authenticate(c, db);
  if (owner === null) {
    logMcp({ outcome: "denied", reason: "token" });
    c.header("WWW-Authenticate", 'Bearer realm="snoboard"');
    return c.json({ error: "a valid personal token is required (Authorization: Bearer sbp_...)" }, 401);
  }
  if (c.req.method === "GET" || c.req.method === "DELETE") {
    // No server-initiated stream and no sessions: the spec allows 405 here.
    c.header("Allow", "POST");
    return c.json({ error: "method not allowed" }, 405);
  }
  if (c.req.method !== "POST") {
    c.header("Allow", "POST");
    return c.json({ error: "method not allowed" }, 405);
  }
  if (!allow(requestStamps, owner.tokenId, MCP_REQUESTS_PER_MINUTE, MINUTE_MS, Date.now())) {
    c.header("Retry-After", "60");
    return c.json(rpcError(null, RATE_LIMITED, "rate limited; try again in a minute"), 429);
  }
  const raw = await c.req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_MCP_BODY_BYTES) return c.json(rpcError(null, INVALID_REQUEST, "request too large"), 413);
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return c.json(rpcError(null, PARSE_ERROR, "parse error"), 400);
  }
  const user: BridgeUser = { key: owner.userKey, display: owner.display };
  const context: ToolContext = { db, owner, user };
  if (Array.isArray(message)) {
    if (message.length === 0 || message.length > 20) return c.json(rpcError(null, INVALID_REQUEST, "invalid batch"), 400);
    const replies = [];
    for (const entry of message) {
      const reply = await handleMessage(entry, context);
      if (reply !== null) replies.push(reply);
    }
    return replies.length === 0 ? c.body(null, 202) : c.json(replies);
  }
  const reply = await handleMessage(message, context);
  if (reply === null) return c.body(null, 202);
  return c.json(reply);
});

function authenticate(c: Context, db: BridgeDb): TokenOwner | null {
  const header = c.req.header("authorization") ?? "";
  const match = /^Bearer\s+(\S{1,200})$/i.exec(header.trim());
  if (match?.[1] === undefined) return null;
  return db.authenticate(match[1]);
}

type ToolContext = { db: BridgeDb; owner: TokenOwner; user: BridgeUser };

async function handleMessage(message: unknown, context: ToolContext) {
  if (!isRecord(message) || message.jsonrpc !== "2.0") return rpcError(null, INVALID_REQUEST, "invalid request");
  const id = message.id;
  const isNotification = id === undefined;
  if (typeof message.method !== "string") {
    // A response from the client needs no answer (the server never sends requests).
    return "result" in message || "error" in message ? null : rpcError(null, INVALID_REQUEST, "invalid request");
  }
  if (id !== undefined && id !== null && typeof id !== "string" && typeof id !== "number") {
    return rpcError(null, INVALID_REQUEST, "invalid id");
  }
  const request = message as JsonRpcRequest;
  if (isNotification) return null;
  const rpcId = id as JsonRpcId;
  switch (request.method) {
    case "initialize": {
      const requested = isRecord(request.params) ? request.params.protocolVersion : undefined;
      const protocolVersion = (SUPPORTED_PROTOCOL_VERSIONS as readonly unknown[]).includes(requested)
        ? (requested as string)
        : LATEST_PROTOCOL_VERSION;
      return rpcResult(rpcId, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "snoboard", title: "Snoboard", version: VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return rpcResult(rpcId, {});
    case "tools/list":
      return rpcResult(rpcId, { tools: TOOLS.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema })) });
    case "tools/call": {
      if (!isRecord(request.params) || typeof request.params.name !== "string") {
        return rpcError(rpcId, INVALID_PARAMS, "tools/call needs a tool name");
      }
      const tool = TOOLS.find((entry) => entry.name === (request.params as { name: string }).name);
      if (tool === undefined) return rpcError(rpcId, INVALID_PARAMS, `unknown tool: ${request.params.name}`);
      const args = request.params.arguments ?? {};
      return rpcResult(rpcId, await callTool(tool, args, context));
    }
    default:
      return rpcError(rpcId, METHOD_NOT_FOUND, `method not found: ${request.method}`);
  }
}

const INSTRUCTIONS = [
  "Snoboard is a git-native kanban board for initiative.md files. You work on a local checkout of the same repository.",
  "Read with list_initiatives, get_initiative, list_docs and read_doc. Change the board in one of two ways:",
  "1) propose_edits / set_doc_from_local: the person reviews your proposal in the board inbox, then submits it as a commit or pull request. Nothing is written to git by these tools.",
  "2) edit the files locally, commit and push to the branch, then call notify_pushed so the board shows the new version at once.",
  "Edits leave out `from` / `fromHash`: the server fills them from the branch, so read first only when you need the current text.",
].join("\n");

type ToolOutcome = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

type ToolDef = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  args: z.ZodType;
  /** Repository the call touches (scope check and audit). */
  repoOf?: (args: never) => string | undefined;
  run: (args: never, context: ToolContext) => Promise<Record<string, unknown>>;
};

class ToolError extends Error {}

const RepoArg = z.string().regex(/^[a-z0-9-]{1,32}$/);
const BranchArg = z.string().min(1).max(200);
const IdArg = z.string().regex(/^[a-z0-9_-]+-\d{3}$/);
const DocPathArg = z.string().min(1).max(300);

const repoProp = { type: "string", description: "Repository id from list_repos" };
const refProp = {
  type: "string",
  description: "Branch to read. Omit for the board's merged view (default branch plus initiative branches).",
};
const branchProp = { type: "string", description: "Branch the edits target (the basket they land in), e.g. main" };
const idProp = { type: "string", description: "Initiative id, e.g. acme-002" };

const EDITS_DESCRIPTION = [
  `Up to ${MAX_VALIDATE_EDITS} edits, applied in order. Each is an object with "kind":`,
  "setStatus {id, to}, setPriority {id, to}, setTitle {id, to}, setIcon {id, to}, setLabels {id, to: string[]},",
  "setIssues {id, to: string[]}, setLinks {id, to: [{title, url}]}, setPhaseStatus {id, phase: number, to},",
  "setBody {id, to: markdown below the frontmatter}, setDoc {id, path, to} (path relative to the initiative folder, .md),",
  "createDoc {id, path, to} (new <name>.md or phases/<name>.md),",
  "createInitiative {project, slug, title, status, priority, depends_on?, body?}.",
  "`from` (and `fromHash` for setBody/setDoc) may be omitted: the server fills them from the branch.",
].join(" ");

function scopeCheck(owner: TokenOwner, repo: string | undefined): void {
  if (repo === undefined) return;
  if (owner.repos !== null && !owner.repos.includes(repo)) throw new ToolError(`this token is not allowed to use repository ${repo}`);
  if (!knownRepos().some((entry) => entry.id === repo)) throw new ToolError(`unknown repository ${repo}`);
}

function knownRepos(): { id: string; name: string }[] {
  const configured = listActiveRepos();
  return configured.length === 0 ? [{ id: DEFAULT_REPO_ID, name: DEFAULT_REPO_ID }] : configured.map(({ id, name }) => ({ id, name }));
}

async function itemView(repo: string, ref: string | undefined, id: string) {
  const resolved = await viewForRef(repo, ref);
  if (!resolved.ok) throw new ToolError(resolved.error);
  const item = resolved.view.snapshot.items.find((entry) => entry.id === id);
  if (item === undefined) throw new ToolError(`${id}: initiative not found${ref === undefined ? "" : ` on ${ref}`}`);
  return { view: resolved.view, item };
}

function docList(item: BoardItem) {
  return {
    docs: (item.docs ?? []).flatMap((doc) =>
      doc.formats.map((format) => ({ path: `${doc.path}.${format}`, kind: doc.kind, ...(doc.phase === undefined ? {} : { phase: doc.phase }) })),
    ),
    reports: (item.reports ?? []).flatMap((report) =>
      report.formats.map((format) => ({
        path: `reports/${report.name}.${format}`,
        ...(report.phase === undefined ? {} : { phase: report.phase }),
      })),
    ),
  };
}

function summaries(edits: readonly unknown[]): string[] {
  return parseEdits(edits).map((edit) => summarizeEdit(edit));
}

const TOOLS: ToolDef[] = [
  {
    name: "list_repos",
    title: "List repositories",
    description: "Repositories this board serves (and this token may use), with their default branch.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    args: z.object({}).strict(),
    run: async (_args: Record<string, never>, { owner }) => ({
      repos: knownRepos()
        .filter((repo) => owner.repos === null || owner.repos.includes(repo.id))
        .map((repo) => ({
          id: repo.id,
          name: repo.name,
          defaultBranch: getConfig(repo.id)?.defaultBranch ?? null,
          editing: editSettingsFor(repo.id).modes,
        })),
    }),
  },
  {
    name: "list_branches",
    title: "List branches",
    description: "Remote branches of a repository, newest first (at most 200). Optional substring filter.",
    inputSchema: {
      type: "object",
      properties: { repo: repoProp, query: { type: "string", description: "Substring filter" } },
      required: ["repo"],
      additionalProperties: false,
    },
    args: z.object({ repo: RepoArg, query: z.string().max(200).optional() }).strict(),
    repoOf: (args: { repo: string }) => args.repo,
    run: async (args: { repo: string; query?: string }) => {
      const source = branchSource(args.repo);
      if (source === undefined) throw new ToolError("snapshot not ready");
      const list = await source.list();
      const query = args.query?.toLowerCase() ?? "";
      const branches = list.branches.filter((branch) => branch.name.toLowerCase().includes(query)).slice(0, 200);
      return { defaultBranch: list.defaultBranch, branches: branches.map(({ name, sha, date }) => ({ name, sha: sha.slice(0, 12), date })) };
    },
  },
  {
    name: "list_initiatives",
    title: "List initiatives",
    description: "Initiatives on the board (merged view, or one branch with ref), filtered by status, project, label or text.",
    inputSchema: {
      type: "object",
      properties: {
        repo: repoProp,
        ref: refProp,
        status: { type: "string" },
        project: { type: "string" },
        label: { type: "string" },
        query: { type: "string", description: "Substring of id or title" },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "Default 200" },
      },
      required: ["repo"],
      additionalProperties: false,
    },
    args: z
      .object({
        repo: RepoArg,
        ref: BranchArg.optional(),
        status: z.string().max(64).optional(),
        project: z.string().max(64).optional(),
        label: z.string().max(64).optional(),
        query: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      })
      .strict(),
    repoOf: (args: { repo: string }) => args.repo,
    run: async (args: { repo: string; ref?: string; status?: string; project?: string; label?: string; query?: string; limit?: number }) => {
      const resolved = await viewForRef(args.repo, args.ref);
      if (!resolved.ok) throw new ToolError(resolved.error);
      const query = args.query?.toLowerCase();
      const items = resolved.view.snapshot.items.filter(
        (item) =>
          (args.status === undefined || item.status === args.status) &&
          (args.project === undefined || item.project === args.project) &&
          (args.label === undefined || (item.labels ?? []).includes(args.label)) &&
          (query === undefined || item.id.includes(query) || item.title.toLowerCase().includes(query)),
      );
      const limit = args.limit ?? 200;
      return {
        statuses: resolved.view.config.statuses,
        priorities: resolved.view.config.priorities,
        total: items.length,
        initiatives: items.slice(0, limit).map((item) => ({
          id: item.id,
          title: item.title,
          status: item.status,
          priority: item.priority,
          project: item.project,
          labels: item.labels ?? [],
          path: item.path,
          sourceRef: item.sourceRef,
          blockedBy: item.blockedBy,
          phases: (item.phases ?? []).map(({ id, title, status }) => ({ id, title, status })),
        })),
      };
    },
  },
  {
    name: "get_initiative",
    title: "Read an initiative",
    description:
      "One initiative: parsed fields, raw frontmatter, markdown body and bodyHash (sha256 used as setBody fromHash), plus its documents and reports.",
    inputSchema: {
      type: "object",
      properties: { repo: repoProp, id: idProp, ref: refProp },
      required: ["repo", "id"],
      additionalProperties: false,
    },
    args: z.object({ repo: RepoArg, id: IdArg, ref: BranchArg.optional() }).strict(),
    repoOf: (args: { repo: string }) => args.repo,
    run: async (args: { repo: string; id: string; ref?: string }) => {
      const { view, item } = await itemView(args.repo, args.ref, args.id);
      const text = await readInitiativeFile(view, item);
      if (text === undefined) throw new ToolError("initiative file could not be read");
      const parts = splitInitiative(text);
      return {
        id: item.id,
        path: item.path,
        sourceRef: item.sourceRef,
        fields: {
          title: item.title,
          status: item.status,
          priority: item.priority,
          labels: item.labels ?? [],
          issues: item.issues ?? [],
          links: item.links ?? [],
          depends_on: item.depends_on,
          phases: item.phases ?? [],
          ...(item.icon === undefined ? {} : { icon: item.icon }),
          updated: item.updated,
        },
        frontmatter: parts?.frontmatter ?? "",
        body: parts?.body ?? "",
        bodyHash: bodyHash(text),
        ...docList(item),
      };
    },
  },
  {
    name: "list_docs",
    title: "List initiative documents",
    description: "Documents (phase packets, task files, ROADMAP.md, ...) and reports of an initiative, paths relative to its folder.",
    inputSchema: {
      type: "object",
      properties: { repo: repoProp, id: idProp, ref: refProp },
      required: ["repo", "id"],
      additionalProperties: false,
    },
    args: z.object({ repo: RepoArg, id: IdArg, ref: BranchArg.optional() }).strict(),
    repoOf: (args: { repo: string }) => args.repo,
    run: async (args: { repo: string; id: string; ref?: string }) => {
      const { item } = await itemView(args.repo, args.ref, args.id);
      return { id: item.id, folder: item.path.slice(0, item.path.lastIndexOf("/")), ...docList(item) };
    },
  },
  {
    name: "read_doc",
    title: "Read an initiative document",
    description: "Text of one listed document or report and its sha256 (the setDoc fromHash).",
    inputSchema: {
      type: "object",
      properties: { repo: repoProp, id: idProp, path: { type: "string", description: "From list_docs, e.g. phases/phase-1.packet.md" }, ref: refProp },
      required: ["repo", "id", "path"],
      additionalProperties: false,
    },
    args: z.object({ repo: RepoArg, id: IdArg, path: DocPathArg, ref: BranchArg.optional() }).strict(),
    repoOf: (args: { repo: string }) => args.repo,
    run: async (args: { repo: string; id: string; path: string; ref?: string }) => {
      const { view, item } = await itemView(args.repo, args.ref, args.id);
      const doc = await readDocument(view, item, args.path);
      if ("error" in doc) throw new ToolError(`${args.path}: ${doc.error}`);
      return { id: item.id, ...doc };
    },
  },
  {
    name: "get_basket",
    title: "Read your basket",
    description: "Your pending edits for a repository and branch (what the board will submit), including accepted proposals.",
    inputSchema: {
      type: "object",
      properties: { repo: repoProp, branch: branchProp },
      required: ["repo", "branch"],
      additionalProperties: false,
    },
    args: z.object({ repo: RepoArg, branch: BranchArg }).strict(),
    repoOf: (args: { repo: string }) => args.repo,
    run: async (args: { repo: string; branch: string }, { db, user }) => {
      const basket = db.getBasket(user.key, args.repo, args.branch);
      const edits = parseEdits(basket.edits);
      return { repo: args.repo, branch: args.branch, updated: basket.updated, count: edits.length, summary: summaries(edits), edits };
    },
  },
  {
    name: "propose_edits",
    title: "Propose board edits",
    description:
      "Check edits against the branch (same rules as the board) and put them in the person's inbox for review. Nothing is committed. Rejected as a whole when any edit does not apply; the per-edit results say why.",
    inputSchema: {
      type: "object",
      properties: {
        repo: repoProp,
        branch: branchProp,
        edits: { type: "array", maxItems: MAX_VALIDATE_EDITS, items: { type: "object" }, description: EDITS_DESCRIPTION },
        note: { type: "string", maxLength: MAX_NOTE_LENGTH, description: "One or two sentences for the reviewer" },
      },
      required: ["repo", "branch", "edits"],
      additionalProperties: false,
    },
    args: z
      .object({ repo: RepoArg, branch: BranchArg, edits: z.array(z.unknown()).min(1).max(MAX_VALIDATE_EDITS), note: z.string().max(MAX_NOTE_LENGTH).optional() })
      .strict(),
    repoOf: (args: { repo: string }) => args.repo,
    run: async (args: { repo: string; branch: string; edits: unknown[]; note?: string }, context) =>
      propose(context, { repo: args.repo, branch: args.branch, note: args.note ?? "", edits: args.edits }),
  },
  {
    name: "set_doc_from_local",
    title: "Propose a document from a local file",
    description:
      "Propose the full new text of an initiative document (e.g. a phase packet you edited locally). The server computes fromHash from the branch; a path that does not exist yet becomes a new document (<name>.md or phases/<name>.md).",
    inputSchema: {
      type: "object",
      properties: {
        repo: repoProp,
        branch: branchProp,
        id: idProp,
        path: { type: "string", description: "Relative to the initiative folder, .md" },
        content: { type: "string", description: "Whole file text (at most 60,000 characters)" },
        note: { type: "string", maxLength: MAX_NOTE_LENGTH },
      },
      required: ["repo", "branch", "id", "path", "content"],
      additionalProperties: false,
    },
    args: z
      .object({
        repo: RepoArg,
        branch: BranchArg,
        id: IdArg,
        path: DocPathArg,
        content: z.string().max(60_000),
        note: z.string().max(MAX_NOTE_LENGTH).optional(),
      })
      .strict(),
    repoOf: (args: { repo: string }) => args.repo,
    run: async (args: { repo: string; branch: string; id: string; path: string; content: string; note?: string }, context) => {
      const resolved = await viewForBranch(args.repo, args.branch);
      if (!resolved.ok) throw new ToolError(resolved.error);
      const edit = await docEditFromLocal(resolved.view, { id: args.id, path: args.path, content: args.content });
      if (!edit.ok) throw new ToolError(edit.error);
      return propose(context, { repo: args.repo, branch: args.branch, note: args.note ?? "", edits: [edit.edit] });
    },
  },
  {
    name: "list_proposals",
    title: "List your proposals",
    description: "Your proposals (newest first) with their status: pending, accepted (in the basket) or rejected.",
    inputSchema: {
      type: "object",
      properties: { repo: repoProp, status: { type: "string", enum: ["pending", "accepted", "rejected"] } },
      additionalProperties: false,
    },
    args: z.object({ repo: RepoArg.optional(), status: z.enum(["pending", "accepted", "rejected"]).optional() }).strict(),
    repoOf: (args: { repo?: string }) => args.repo,
    run: async (args: { repo?: string; status?: "pending" | "accepted" | "rejected" }, { db, user, owner }) => ({
      proposals: db
        .listProposals(user.key, { ...(args.repo === undefined ? {} : { repo: args.repo }), ...(args.status === undefined ? {} : { status: args.status }), limit: 50 })
        .filter((proposal) => owner.repos === null || owner.repos.includes(proposal.repo))
        .map((proposal) => ({
          id: proposal.id,
          repo: proposal.repo,
          branch: proposal.branch,
          status: proposal.status,
          source: proposal.source,
          note: proposal.note,
          created: proposal.created,
          summary: summaries(proposal.edits),
        })),
    }),
  },
  {
    name: "notify_pushed",
    title: "Refresh the board after a push",
    description:
      "Call after you pushed commits to a branch: the board fetches the repository now (instead of at its next interval) and open boards reload. Rate-limited.",
    inputSchema: {
      type: "object",
      properties: { repo: repoProp, branch: branchProp },
      required: ["repo", "branch"],
      additionalProperties: false,
    },
    args: z.object({ repo: RepoArg, branch: BranchArg }).strict(),
    repoOf: (args: { repo: string }) => args.repo,
    run: async (args: { repo: string; branch: string }, { owner }) => {
      const key = `${owner.tokenId}\n${args.repo}\n${args.branch}`;
      const now = Date.now();
      const previous = notifyStamps.get(key);
      if (previous !== undefined && now - previous < NOTIFY_WINDOW_MS) {
        throw new ToolError(`already refreshing; try again in ${Math.ceil((NOTIFY_WINDOW_MS - (now - previous)) / 1000)}s`);
      }
      notifyStamps.set(key, now);
      const config = getConfig(args.repo);
      const isDefault = config !== null && config.defaultBranch === args.branch;
      branchSource(args.repo)?.forget(args.branch);
      // The merged board refreshes on its own and publishes when refs moved; a branch view is
      // dropped from the cache and announced so open views of it reload.
      void requestRefresh(args.repo)
        .catch(() => undefined)
        .then(() => {
          if (!isDefault) publishSnapshot(args.repo, args.branch);
        });
      return { accepted: true, repo: args.repo, branch: args.branch };
    },
  },
];

async function propose(
  context: ToolContext,
  input: { repo: string; branch: string; note: string; edits: unknown[] },
): Promise<Record<string, unknown>> {
  if (!allow(proposalStamps, context.owner.tokenId, MCP_PROPOSALS_PER_HOUR, HOUR_MS, Date.now())) {
    throw new ToolError(`at most ${MCP_PROPOSALS_PER_HOUR} proposals per hour per token`);
  }
  const outcome = await proposeEdits(context.db, context.user, { ...input, source: context.owner.tokenName });
  if (!outcome.ok) {
    return {
      ok: false,
      code: outcome.code,
      error: outcome.error,
      ...(outcome.results === undefined ? {} : { results: outcome.results }),
    };
  }
  const settings = agentBridgeSettings();
  const base = settings?.mcpUrl === undefined ? undefined : new URL(settings.mcpUrl).origin;
  return {
    ok: true,
    proposalId: outcome.proposal.id,
    status: "pending",
    results: outcome.results,
    summary: summaries(outcome.proposal.edits),
    message: "Waiting for review in the board inbox. Nothing is committed until the person submits their basket.",
    ...(base === undefined ? {} : { boardUrl: `${base}/r/${encodeURIComponent(input.repo)}/` }),
  };
}

async function callTool(tool: ToolDef, rawArgs: unknown, context: ToolContext): Promise<ToolOutcome> {
  const started = Date.now();
  const parsed = tool.args.safeParse(rawArgs);
  if (!parsed.success) {
    logMcp({ outcome: "denied", reason: "invalid_args", tool: tool.name, owner: context.owner });
    return errorOutcome(`invalid arguments: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "args"}: ${issue.message}`).join("; ")}`);
  }
  const repo = tool.repoOf?.(parsed.data as never);
  try {
    scopeCheck(context.owner, repo);
    const result = await tool.run(parsed.data as never, context);
    const text = JSON.stringify(result, null, 2);
    if (Buffer.byteLength(text, "utf8") > MAX_TOOL_RESULT_BYTES) {
      logMcp({ outcome: "failed", reason: "too_large", tool: tool.name, owner: context.owner, repo, ms: Date.now() - started });
      return errorOutcome(`the result is over ${MAX_TOOL_RESULT_BYTES / 1024} KiB; narrow the request (filters, limit, one document)`);
    }
    const failed = result.ok === false;
    logMcp({
      outcome: failed ? "failed" : "ok",
      reason: failed && typeof result.code === "string" ? result.code : "ok",
      tool: tool.name,
      owner: context.owner,
      repo,
      ms: Date.now() - started,
    });
    return { content: [{ type: "text", text }], structuredContent: result, ...(failed ? { isError: true } : {}) };
  } catch (error) {
    const message = error instanceof ToolError ? error.message : "internal error";
    if (!(error instanceof ToolError)) console.error(`snoboard: mcp tool ${tool.name} failed`);
    logMcp({ outcome: "failed", reason: error instanceof ToolError ? "tool_error" : "internal", tool: tool.name, owner: context.owner, repo, ms: Date.now() - started });
    return errorOutcome(message);
  }
}

function errorOutcome(message: string): ToolOutcome {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** One info line per MCP request outcome: never tokens, edit text or document content. */
function logMcp(input: {
  outcome: "ok" | "denied" | "failed";
  reason: string;
  tool?: string;
  owner?: TokenOwner;
  repo?: string | undefined;
  ms?: number;
}): void {
  const parts = [`snoboard: mcp ${input.outcome}`, `reason=${JSON.stringify(input.reason)}`];
  if (input.tool !== undefined) parts.push(`tool=${JSON.stringify(input.tool)}`);
  if (input.owner !== undefined) {
    parts.push(`user=${JSON.stringify(input.owner.userKey.slice(0, 200))}`, `token=${JSON.stringify(input.owner.tokenId)}`);
  }
  if (input.repo !== undefined) parts.push(`repo=${JSON.stringify(input.repo)}`);
  if (input.ms !== undefined) parts.push(`ms=${input.ms}`);
  console.info(parts.join(" "));
}

/** Tool names, for docs and tests. */
export const MCP_TOOL_NAMES = TOOLS.map((tool) => tool.name);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
