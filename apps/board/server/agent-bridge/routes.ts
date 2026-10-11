import type { Context } from "hono";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { EditSchema, isValidBranchName, type Edit } from "snoboard";
import { z } from "zod";
import { isKnownRepo } from "../api.js";
import type { BoardEnv } from "../auth/middleware.js";
import { csrfMatches, issueCsrfToken, submitSubject } from "../edits/submit.js";
import type { BridgeDb, ProposalStatus } from "./db.js";
import { subscribe, type BridgeEvent } from "./events.js";
import { MCP_TOOL_NAMES } from "./mcp.js";
import { acceptProposal, MAX_BASKET_BYTES, parseEdits, rejectProposal, writeBasket } from "./service.js";
import { agentBridgeSettings, bridgeDb, bridgeUser, type BridgeUser } from "./settings.js";

/** Body limit for `PUT /api/agent/basket` (a basket of document edits plus the sync fields). */
export const MAX_BASKET_BODY_BYTES = MAX_BASKET_BYTES + 16 * 1024;
export const AGENT_BASKET_PATH = /^\/api\/agent\/basket$/;
/** SSE keep-alive comment interval. */
export const EVENTS_HEARTBEAT_MS = 25_000;
export const CSRF_HEADER = "x-snoboard-csrf";

export const agentRoutes = new Hono<BoardEnv>();

type Ready = { db: BridgeDb; user: BridgeUser; subject: string };

/** 404 when the bridge is off, 403 for a sign-in without a personal identity. */
function ready(c: Context<BoardEnv>): Ready | Response {
  const db = bridgeDb();
  if (agentBridgeSettings() === null || db === null) return c.json({ error: "not found" }, 404);
  c.header("Cache-Control", "no-store");
  const user = bridgeUser(c);
  const subject = submitSubject(c);
  if (user === null || subject === null) {
    return c.json({ code: "no_identity", error: "agent access needs a personal sign-in (GitHub or Cloudflare Access)" }, 403);
  }
  return { db, user, subject };
}

function csrfOk(c: Context<BoardEnv>, subject: string, bodyToken?: unknown): boolean {
  return csrfMatches(subject, bodyToken ?? c.req.header(CSRF_HEADER));
}

agentRoutes.get("/agent/config", (c) => {
  const settings = agentBridgeSettings();
  if (settings === null) return c.json({ enabled: false });
  c.header("Cache-Control", "no-store");
  const user = bridgeUser(c);
  const subject = submitSubject(c);
  if (user === null || subject === null) return c.json({ enabled: true, available: false, reason: "no_identity" });
  return c.json({
    enabled: true,
    available: true,
    user: { display: user.display },
    ...(settings.mcpUrl === undefined ? {} : { mcpUrl: settings.mcpUrl }),
    tools: MCP_TOOL_NAMES,
    csrf: issueCsrfToken(subject),
  });
});

agentRoutes.get("/agent/tokens", (c) => {
  const state = ready(c);
  if (state instanceof Response) return state;
  return c.json({ tokens: state.db.listTokens(state.user.key) });
});

const TokenBody = z
  .object({
    name: z.string().trim().min(1).max(64).regex(/^[^\r\n\t]+$/),
    repos: z.array(z.string().regex(/^[a-z0-9-]{1,32}$/)).max(32).optional(),
    csrf: z.string(),
  })
  .strict();

agentRoutes.post("/agent/tokens", async (c) => {
  const state = ready(c);
  if (state instanceof Response) return state;
  const parsed = TokenBody.safeParse(await readJson(c));
  if (!parsed.success) return c.json({ code: "invalid", error: "name (1-64 characters) and csrf are required" }, 400);
  if (!csrfOk(c, state.subject, parsed.data.csrf)) return c.json({ code: "csrf", error: "reload the page and try again" }, 403);
  const repos = parsed.data.repos === undefined || parsed.data.repos.length === 0 ? null : [...new Set(parsed.data.repos)];
  if (repos !== null && repos.some((repo) => !isKnownRepo(repo))) return c.json({ code: "invalid", error: "unknown repository" }, 400);
  const created = state.db.createToken(state.user.key, state.user.display, parsed.data.name, repos);
  if ("error" in created) return c.json({ code: "too_many", error: "too many tokens; revoke one first" }, 409);
  console.info(`snoboard: agent token created user=${JSON.stringify(state.user.key)} token=${JSON.stringify(created.row.id)}`);
  // The secret is in this response only; the server keeps its SHA-256 hash.
  return c.json({ token: created.token, ...created.row }, 201);
});

agentRoutes.delete("/agent/tokens/:id", (c) => {
  const state = ready(c);
  if (state instanceof Response) return state;
  if (!csrfOk(c, state.subject)) return c.json({ code: "csrf", error: "reload the page and try again" }, 403);
  const id = c.req.param("id");
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(id) || !state.db.revokeToken(state.user.key, id)) {
    return c.json({ code: "not_found", error: "token not found" }, 404);
  }
  console.info(`snoboard: agent token revoked user=${JSON.stringify(state.user.key)} token=${JSON.stringify(id)}`);
  return c.json({ revoked: true });
});

function repoBranch(repo: unknown, branch: unknown): { repo: string; branch: string } | null {
  if (typeof repo !== "string" || typeof branch !== "string") return null;
  if (!isKnownRepo(repo) || !isValidBranchName(branch)) return null;
  return { repo, branch };
}

agentRoutes.get("/agent/basket", (c) => {
  const state = ready(c);
  if (state instanceof Response) return state;
  const target = repoBranch(c.req.query("repo"), c.req.query("branch"));
  if (target === null) return c.json({ code: "invalid", error: "repo and branch are required" }, 400);
  const basket = state.db.getBasket(state.user.key, target.repo, target.branch);
  return c.json({ edits: parseEdits(basket.edits), updated: basket.updated });
});

const KeyList = z.array(z.string().max(400)).max(500);
const BasketBody = z
  .object({
    repo: z.string(),
    branch: z.string(),
    edits: z.array(z.unknown()).max(500),
    baseUpdated: z.number().int().nonnegative(),
    changedKeys: KeyList,
    removedKeys: KeyList,
    csrf: z.string(),
  })
  .strict();

agentRoutes.put("/agent/basket", async (c) => {
  const state = ready(c);
  if (state instanceof Response) return state;
  const raw = await c.req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BASKET_BODY_BYTES) return c.json({ code: "too_large", error: "basket too large" }, 413);
  const parsed = BasketBody.safeParse(parseJson(raw));
  if (!parsed.success) return c.json({ code: "invalid", error: "invalid basket" }, 400);
  if (!csrfOk(c, state.subject, parsed.data.csrf)) return c.json({ code: "csrf", error: "reload the page and try again" }, 403);
  const target = repoBranch(parsed.data.repo, parsed.data.branch);
  if (target === null) return c.json({ code: "invalid", error: "unknown repository or invalid branch" }, 400);
  const edits: Edit[] = [];
  for (const entry of parsed.data.edits) {
    const edit = EditSchema.safeParse(entry);
    if (!edit.success) return c.json({ code: "invalid", error: "the basket holds an invalid edit" }, 400);
    edits.push(edit.data);
  }
  const written = writeBasket(
    state.db,
    state.user,
    {
      ...target,
      edits,
      baseUpdated: parsed.data.baseUpdated,
      change: { changedKeys: parsed.data.changedKeys, removedKeys: parsed.data.removedKeys },
    },
    "browser",
  );
  if (!written.ok) return c.json({ code: written.code, error: written.error }, 413);
  return c.json({ edits: parseEdits(written.basket.edits), updated: written.basket.updated, merged: written.merged });
});

agentRoutes.get("/agent/proposals", (c) => {
  const state = ready(c);
  if (state instanceof Response) return state;
  const repo = c.req.query("repo");
  const status = c.req.query("status");
  if (repo !== undefined && !isKnownRepo(repo)) return c.json({ code: "invalid", error: "unknown repository" }, 400);
  if (status !== undefined && status !== "pending" && status !== "accepted" && status !== "rejected") {
    return c.json({ code: "invalid", error: "invalid status" }, 400);
  }
  const proposals = state.db.listProposals(state.user.key, {
    ...(repo === undefined ? {} : { repo }),
    ...(status === undefined ? {} : { status: status as ProposalStatus }),
    limit: 200,
  });
  return c.json({ proposals: proposals.map((proposal) => ({ ...proposal, edits: parseEdits(proposal.edits) })) });
});

agentRoutes.post("/agent/proposals/:id/accept", async (c) => {
  const state = ready(c);
  if (state instanceof Response) return state;
  const body = await readJson(c);
  if (!csrfOk(c, state.subject, isRecord(body) ? body.csrf : undefined)) return c.json({ code: "csrf", error: "reload the page and try again" }, 403);
  const result = acceptProposal(state.db, state.user, c.req.param("id"));
  if (!result.ok) return c.json({ code: result.code, error: result.error }, result.code === "not_found" ? 404 : 409);
  return c.json({ proposal: { ...result.proposal, edits: parseEdits(result.proposal.edits) }, basket: { edits: parseEdits(result.basket.edits), updated: result.basket.updated } });
});

agentRoutes.post("/agent/proposals/:id/reject", async (c) => {
  const state = ready(c);
  if (state instanceof Response) return state;
  const body = await readJson(c);
  if (!csrfOk(c, state.subject, isRecord(body) ? body.csrf : undefined)) return c.json({ code: "csrf", error: "reload the page and try again" }, 403);
  const result = rejectProposal(state.db, state.user, c.req.param("id"));
  if (!result.ok) return c.json({ code: result.code, error: result.error }, result.code === "not_found" ? 404 : 409);
  return c.json({ rejected: true });
});

agentRoutes.post("/agent/proposals/accept-all", async (c) => {
  const state = ready(c);
  if (state instanceof Response) return state;
  const body = await readJson(c);
  if (!isRecord(body) || !csrfOk(c, state.subject, body.csrf)) return c.json({ code: "csrf", error: "reload the page and try again" }, 403);
  const repo = typeof body.repo === "string" ? body.repo : undefined;
  if (repo !== undefined && !isKnownRepo(repo)) return c.json({ code: "invalid", error: "unknown repository" }, 400);
  const pending = state.db.listProposals(state.user.key, { ...(repo === undefined ? {} : { repo }), status: "pending", limit: 500 });
  const accepted: string[] = [];
  const failed: { id: string; error: string }[] = [];
  // Oldest first, so later proposals for the same target win as they would one by one.
  for (const proposal of [...pending].reverse()) {
    const result = acceptProposal(state.db, state.user, proposal.id);
    if (result.ok) accepted.push(proposal.id);
    else failed.push({ id: proposal.id, error: result.error });
  }
  return c.json({ accepted, failed });
});

agentRoutes.get("/events", (c) => {
  const state = ready(c);
  if (state instanceof Response) return state;
  c.header("X-Accel-Buffering", "no");
  return streamSSE(c, async (stream) => {
    const queue: BridgeEvent[] = [];
    let wake: (() => void) | undefined;
    const unsubscribe = subscribe(state.user.key, (event) => {
      queue.push(event);
      wake?.();
    });
    if (unsubscribe === null) {
      await stream.writeSSE({ event: "error", data: JSON.stringify({ code: "too_many_streams" }) });
      return;
    }
    let closed = false;
    stream.onAbort(() => {
      closed = true;
      wake?.();
    });
    try {
      await stream.writeSSE({ event: "ready", data: JSON.stringify({ at: new Date().toISOString() }), retry: 5000 });
      while (!closed) {
        while (queue.length > 0 && !closed) {
          const event = queue.shift()!;
          await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
        }
        if (closed) break;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, EVENTS_HEARTBEAT_MS);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = undefined;
        if (queue.length === 0 && !closed) await stream.write(": keep-alive\n\n");
      }
    } finally {
      unsubscribe();
    }
  });
});

async function readJson(c: Context<BoardEnv>): Promise<unknown> {
  return parseJson(await c.req.text());
}

function parseJson(raw: string): unknown {
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
