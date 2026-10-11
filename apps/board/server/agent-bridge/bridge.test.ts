import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bodyHash, buildSnapshot, docHash, editKey, loadConfig, type Edit } from "snoboard";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTmpRepo, type TmpRepo } from "../../../../packages/core/src/test-utils/tmp-repo.ts";
import { resetAuthConfig, setAuthConfig, type AuthConfig } from "../auth/env.js";
import { SESSION_COOKIE, signSession, type SessionMethod } from "../auth/session.js";
import { resetSubmitState } from "../edits/submit.js";
import { app } from "../index.js";
import { setInitiativeRepoDir } from "../repo-sync.js";
import { resetStore, seedStore } from "../store.js";
import { BridgeDb } from "./db.js";
import { onSnapshotPublished, openStreams, resetEvents } from "./events.js";
import { MCP_TOOL_NAMES, resetMcpLimits } from "./mcp.js";
import { loadAgentBridgeSettings, setAgentBridge, type AgentBridgeSettings } from "./settings.js";

const refresh = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../repo-sync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repo-sync.js")>();
  return { ...actual, requestRefresh: refresh };
});

const ORIGIN = "http://localhost:3000";
const sessionSecret = randomBytes(32);
const demoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../examples/demo-repo");
const ROADMAP = "# Roadmap\n\nPlan.\n";

const auth: AuthConfig = {
  modes: ["password", "github"],
  publicUrl: ORIGIN,
  sessionSecret,
  passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$aaaaaaaaaaaaaaaa$bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  github: { clientId: "client", clientSecret: "secret", allowedLogins: ["ada", "grace"], allowedOrgs: [] },
};

const settings: AgentBridgeSettings = {
  enabled: true,
  dbFile: ":memory:",
  sharedPasswordUser: false,
  allowedOrigins: [],
  mcpUrl: `${ORIGIN}/mcp`,
};

const cookies = new Map<string, string>();

/** One session per person, so the CSRF token (bound to the session) stays valid across requests. */
function cookie(sub: string, method: SessionMethod = "github"): string {
  const key = `${method}:${sub}`;
  let value = cookies.get(key);
  if (value === undefined) {
    const iat = Date.now();
    value = `${SESSION_COOKIE}=${signSession(sessionSecret, { sub, method, iat, exp: iat + 3_600_000 })}`;
    cookies.set(key, value);
  }
  return value;
}

function as(sub: string, init: RequestInit = {}, method: SessionMethod = "github"): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie(sub, method));
  if (init.method !== undefined && init.method !== "GET") headers.set("origin", ORIGIN);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return { ...init, headers };
}

async function readTree(dir: string, prefix = ""): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(files, await readTree(full, relative));
    else files[relative] = await readFile(full, "utf8");
  }
  return files;
}

let repo: TmpRepo;
let initiativeText: string;

beforeAll(async () => {
  const files = await readTree(demoRoot);
  files["initiatives/acme/001-onboarding/ROADMAP.md"] = ROADMAP;
  repo = await createTmpRepo({ commits: [{ message: "demo", files }] });
  initiativeText = files["initiatives/acme/002-billing/initiative.md"] ?? "";
});

afterAll(async () => {
  await repo.remove();
});

let db: BridgeDb;

beforeEach(async () => {
  setAuthConfig(auth);
  const config = loadConfig(await readFile(path.join(demoRoot, ".snoboard.yml"), "utf8"));
  seedStore(await buildSnapshot(repo.dir, config), config);
  setInitiativeRepoDir(repo.dir);
  db = new BridgeDb(":memory:");
  setAgentBridge(settings, db);
});

afterEach(() => {
  setAgentBridge(null);
  resetStore();
  resetAuthConfig();
  resetSubmitState();
  resetMcpLimits();
  resetEvents();
  setInitiativeRepoDir(undefined);
  refresh.mockClear();
});

async function agentConfig(sub: string): Promise<{ csrf: string }> {
  const response = await app.request("/api/agent/config", as(sub));
  expect(response.status).toBe(200);
  return (await response.json()) as { csrf: string };
}

async function newToken(sub: string, repos?: string[]): Promise<string> {
  const { csrf } = await agentConfig(sub);
  const response = await app.request(
    "/api/agent/tokens",
    as(sub, { method: "POST", body: JSON.stringify({ name: `${sub} laptop`, csrf, ...(repos === undefined ? {} : { repos }) }) }),
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as { token: string };
  return body.token;
}

let rpcId = 0;

async function mcp(token: string | undefined, method: string, params?: unknown, headers: Record<string, string> = {}) {
  rpcId += 1;
  return app.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, ...(params === undefined ? {} : { params }) }),
  });
}

type ToolResult = { content: { type: string; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

async function call(token: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const response = await mcp(token, "tools/call", { name, arguments: args });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { result?: ToolResult; error?: unknown };
  expect(body.error).toBeUndefined();
  return body.result!;
}

function data(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe("agent bridge settings", () => {
  it("is off unless enabled and refuses sign-ins without a personal identity", () => {
    expect(loadAgentBridgeSettings({}, auth)).toBeNull();
    expect(loadAgentBridgeSettings({ SNOBOARD_AGENT_BRIDGE: "false" }, auth)).toBeNull();
    expect(() => loadAgentBridgeSettings({ SNOBOARD_AGENT_BRIDGE: "yes" }, auth)).toThrow(/true or false/);
    expect(() => loadAgentBridgeSettings({ SNOBOARD_AGENT_BRIDGE: "true" }, { modes: ["none"] })).toThrow(/none/);
    expect(() => loadAgentBridgeSettings({ SNOBOARD_AGENT_BRIDGE: "true" }, { modes: ["password"] })).toThrow(/PASSWORD_USER=shared/);
    const shared = loadAgentBridgeSettings(
      { SNOBOARD_AGENT_BRIDGE: "true", SNOBOARD_AGENT_BRIDGE_PASSWORD_USER: "shared", SNOBOARD_DATA_DIR: "/data" },
      { modes: ["password"], publicUrl: "https://board.example.com" },
    );
    expect(shared).toMatchObject({ sharedPasswordUser: true, mcpUrl: "https://board.example.com/mcp" });
    expect(shared?.dbFile.replaceAll("\\", "/")).toBe("/data/snoboard.db");
    const state = loadAgentBridgeSettings({ SNOBOARD_AGENT_BRIDGE: "true", SNOBOARD_STATE_DIR: "/state", SNOBOARD_DATA_DIR: "/data" }, auth);
    expect(state?.dbFile.replaceAll("\\", "/")).toBe("/state/snoboard.db");
    expect(() =>
      loadAgentBridgeSettings({ SNOBOARD_AGENT_BRIDGE: "true", SNOBOARD_AGENT_BRIDGE_ALLOWED_ORIGINS: "https://x.example/path" }, auth),
    ).toThrow(/not an origin/);
  });

  it("answers 404 everywhere when the bridge is off", async () => {
    setAgentBridge(null);
    expect(await (await app.request("/api/agent/config", as("ada"))).json()).toEqual({ enabled: false });
    expect((await app.request("/api/agent/tokens", as("ada"))).status).toBe(404);
    expect((await app.request("/api/events", as("ada"))).status).toBe(404);
    expect((await mcp("sbp_x", "initialize")).status).toBe(404);
  });

  it("refuses password users unless the shared user is enabled", async () => {
    const config = await app.request("/api/agent/config", as("board", {}, "password"));
    expect(await config.json()).toEqual({ enabled: true, available: false, reason: "no_identity" });
    expect((await app.request("/api/agent/tokens", as("board", {}, "password"))).status).toBe(403);
    setAgentBridge({ ...settings, sharedPasswordUser: true }, new BridgeDb(":memory:"));
    const shared = (await (await app.request("/api/agent/config", as("board", {}, "password"))).json()) as { available: boolean };
    expect(shared.available).toBe(true);
  });
});

describe("personal tokens", () => {
  it("creates (shown once), lists without secrets, and revokes with CSRF", async () => {
    const token = await newToken("ada");
    expect(token).toMatch(/^sbp_/);
    const list = await app.request("/api/agent/tokens", as("ada"));
    const listed = (await list.json()) as { tokens: { id: string; name: string }[] };
    expect(listed.tokens).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(token);
    expect(((await (await app.request("/api/agent/tokens", as("grace"))).json()) as { tokens: unknown[] }).tokens).toEqual([]);

    const id = listed.tokens[0]!.id;
    const noCsrf = await app.request(`/api/agent/tokens/${id}`, as("ada", { method: "DELETE" }));
    expect(noCsrf.status).toBe(403);
    const { csrf } = await agentConfig("grace");
    const otherUser = await app.request(`/api/agent/tokens/${id}`, as("grace", { method: "DELETE", headers: { "x-snoboard-csrf": csrf } }));
    expect(otherUser.status).toBe(404);
    expect((await mcp(token, "ping")).status).toBe(200);
    const own = await agentConfig("ada");
    const revoked = await app.request(`/api/agent/tokens/${id}`, as("ada", { method: "DELETE", headers: { "x-snoboard-csrf": own.csrf } }));
    expect(revoked.status).toBe(200);
    expect((await mcp(token, "ping")).status).toBe(401);
  });

  it("rejects a cross-site token creation and a bad CSRF token", async () => {
    const { csrf } = await agentConfig("ada");
    const crossSite = await app.request("/api/agent/tokens", {
      method: "POST",
      headers: { cookie: cookie("ada"), origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ name: "x", csrf }),
    });
    expect(crossSite.status).toBe(403);
    const badCsrf = await app.request("/api/agent/tokens", as("ada", { method: "POST", body: JSON.stringify({ name: "x", csrf: "nope" }) }));
    expect(badCsrf.status).toBe(403);
  });
});

describe("MCP endpoint", () => {
  it("requires a bearer token and refuses browser origins", async () => {
    const missing = await mcp(undefined, "initialize");
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain("Bearer");
    expect((await mcp("sbp_not-a-real-token", "initialize")).status).toBe(401);
    const token = await newToken("ada");
    expect((await mcp(token, "initialize", {}, { origin: "https://evil.example" })).status).toBe(403);
    // Session cookies are not MCP credentials.
    const cookieOnly = await app.request("/mcp", {
      method: "POST",
      headers: { cookie: cookie("ada"), "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(cookieOnly.status).toBe(401);
    expect((await app.request("/mcp", { method: "GET", headers: { authorization: `Bearer ${token}` } })).status).toBe(405);
  });

  it("speaks the protocol: initialize, notifications, tools/list, errors", async () => {
    const token = await newToken("ada");
    const init = await mcp(token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    const initBody = (await init.json()) as { result: { protocolVersion: string; capabilities: { tools: unknown }; serverInfo: { name: string } } };
    expect(initBody.result.protocolVersion).toBe("2025-06-18");
    expect(initBody.result.serverInfo.name).toBe("snoboard");
    expect(initBody.result.capabilities.tools).toBeDefined();
    const old = (await (await mcp(token, "initialize", { protocolVersion: "1999-01-01" })).json()) as { result: { protocolVersion: string } };
    expect(old.result.protocolVersion).toBe("2025-06-18");

    const notification = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(notification.status).toBe(202);

    const list = (await (await mcp(token, "tools/list")).json()) as { result: { tools: { name: string; inputSchema: { type: string } }[] } };
    expect(list.result.tools.map((tool) => tool.name)).toEqual(MCP_TOOL_NAMES);
    expect(MCP_TOOL_NAMES).toEqual(
      expect.arrayContaining([
        "list_repos",
        "list_branches",
        "list_initiatives",
        "get_initiative",
        "list_docs",
        "read_doc",
        "get_basket",
        "propose_edits",
        "set_doc_from_local",
        "notify_pushed",
      ]),
    );
    for (const tool of list.result.tools) expect(tool.inputSchema.type).toBe("object");

    const unknown = (await (await mcp(token, "resources/list")).json()) as { error: { code: number } };
    expect(unknown.error.code).toBe(-32601);
    const parse = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{",
    });
    expect(((await parse.json()) as { error: { code: number } }).error.code).toBe(-32700);
    const badArgs = await call(token, "get_initiative", { repo: "default" });
    expect(badArgs.isError).toBe(true);
    expect(badArgs.content[0]!.text).toContain("invalid arguments");
  });

  it("reads repos, initiatives, documents and the basket", async () => {
    const token = await newToken("ada");
    const repos = data(await call(token, "list_repos", {}));
    expect(repos.repos).toEqual([{ id: "default", name: "default", defaultBranch: "main", editing: [] }]);

    const list = data(await call(token, "list_initiatives", { repo: "default", project: "acme" })) as {
      initiatives: { id: string }[];
      statuses: string[];
    };
    expect(list.initiatives.map((item) => item.id).sort()).toEqual(["acme-001", "acme-002", "acme-003"]);
    expect(list.statuses).toContain("planned");
    const filtered = data(await call(token, "list_initiatives", { repo: "default", status: "in-progress" })) as { initiatives: { id: string }[] };
    expect(filtered.initiatives.map((item) => item.id)).toEqual(["acme-002"]);

    const initiative = data(await call(token, "get_initiative", { repo: "default", id: "acme-002" })) as {
      fields: { status: string };
      frontmatter: string;
      body: string;
      bodyHash: string;
      docs: { path: string }[];
    };
    expect(initiative.fields.status).toBe("in-progress");
    expect(initiative.frontmatter).toContain("id: acme-002");
    expect(initiative.body).toContain("# Billing");
    expect(initiative.bodyHash).toBe(bodyHash(initiativeText));
    expect(initiative.docs.map((doc) => doc.path)).toEqual(expect.arrayContaining(["ROADMAP.md", "phases/phase-1.packet.md"]));

    const docs = data(await call(token, "list_docs", { repo: "default", id: "acme-001" })) as { docs: { path: string }[] };
    expect(docs.docs.map((doc) => doc.path)).toEqual(["ROADMAP.md"]);
    const doc = data(await call(token, "read_doc", { repo: "default", id: "acme-001", path: "ROADMAP.md" }));
    expect(doc).toMatchObject({ text: ROADMAP, hash: docHash(ROADMAP), format: "md" });
    const outside = await call(token, "read_doc", { repo: "default", id: "acme-001", path: "../002-billing/initiative.md" });
    expect(outside.isError).toBe(true);

    const basket = data(await call(token, "get_basket", { repo: "default", branch: "main" }));
    expect(basket).toMatchObject({ count: 0, edits: [] });
    const missingRepo = await call(token, "list_initiatives", { repo: "other" });
    expect(missingRepo.isError).toBe(true);
  });

  it("validates, fills and stores proposals; invalid batches store nothing", async () => {
    const token = await newToken("ada");
    const accepted = data(
      await call(token, "propose_edits", {
        repo: "default",
        branch: "main",
        note: "plan it",
        edits: [
          { kind: "setStatus", id: "acme-002", to: "review" },
          { kind: "setBody", id: "acme-002", to: "\n# Billing\n\nRewritten.\n" },
          { kind: "setDoc", id: "acme-001", path: "ROADMAP.md", to: "# Roadmap\n\nNew plan.\n" },
        ],
      }),
    ) as { ok: boolean; proposalId: string; summary: string[] };
    expect(accepted.ok).toBe(true);
    expect(accepted.summary[0]).toBe("acme-002: status in-progress -> review");
    const stored = db.getProposal("github:ada", accepted.proposalId);
    expect(stored?.note).toBe("plan it");
    expect(stored?.source).toBe("ada laptop");
    const edits = stored?.edits as Edit[];
    expect(edits[0]).toEqual({ kind: "setStatus", id: "acme-002", from: "in-progress", to: "review" });
    expect(edits[1]).toMatchObject({ kind: "setBody", fromHash: bodyHash(initiativeText) });
    expect(edits[2]).toMatchObject({ kind: "setDoc", fromHash: docHash(ROADMAP) });

    const rejected = await call(token, "propose_edits", {
      repo: "default",
      branch: "main",
      edits: [
        { kind: "setStatus", id: "acme-002", to: "review" },
        { kind: "setStatus", id: "acme-002", from: "idea", to: "done" },
      ],
    });
    expect(rejected.isError).toBe(true);
    const rejectedBody = data(rejected) as { ok: boolean; results: { ok: boolean }[] };
    expect(rejectedBody.ok).toBe(false);
    expect(rejectedBody.results.map((result) => result.ok)).toEqual([true, false]);
    expect(db.listProposals("github:ada")).toHaveLength(1);

    const image = await call(token, "propose_edits", {
      repo: "default",
      branch: "main",
      edits: [{ kind: "addAttachment", id: "acme-002", path: "assets/a.png", contentType: "image/png", sha256: "0".repeat(64), size: 1 }],
    });
    expect(image.isError).toBe(true);

    const local = data(
      await call(token, "set_doc_from_local", {
        repo: "default",
        branch: "main",
        id: "acme-001",
        path: "phases/phase-1.packet.md",
        content: "# Phase 1\n",
      }),
    ) as { ok: boolean; proposalId: string };
    expect(local.ok).toBe(true);
    expect((db.getProposal("github:ada", local.proposalId)?.edits as Edit[])[0]).toMatchObject({ kind: "createDoc" });
    const proposals = data(await call(token, "list_proposals", {})) as { proposals: { id: string }[] };
    expect(proposals.proposals).toHaveLength(2);
    expect(db.listProposals("github:grace")).toEqual([]);
  });

  it("keeps a token to its repositories", async () => {
    const token = await newToken("ada", ["default"]);
    expect((await call(token, "list_initiatives", { repo: "default" })).isError).toBeUndefined();
    db.db.prepare("UPDATE mcp_tokens SET repos = ?").run(JSON.stringify(["other"]));
    const denied = await call(token, "list_initiatives", { repo: "default" });
    expect(denied.isError).toBe(true);
    expect(denied.content[0]!.text).toContain("not allowed");
    expect(data(await call(token, "list_repos", {}))).toEqual({ repos: [] });
  });

  it("rate-limits notify_pushed and refreshes the repository", async () => {
    const token = await newToken("ada");
    const published: [string, string | null][] = [];
    onSnapshotPublished((repoId, ref) => published.push([repoId, ref]));
    const first = data(await call(token, "notify_pushed", { repo: "default", branch: "feat/x" }));
    expect(first).toMatchObject({ accepted: true });
    expect(refresh).toHaveBeenCalledWith("default");
    await vi.waitFor(() => expect(published).toEqual([["default", "feat/x"]]));
    const again = await call(token, "notify_pushed", { repo: "default", branch: "feat/x" });
    expect(again.isError).toBe(true);
    expect(again.content[0]!.text).toContain("try again");
  });

  it("caps tool calls per token per minute", async () => {
    const token = await newToken("ada");
    let last = 200;
    for (let index = 0; index < 125 && last === 200; index += 1) last = (await mcp(token, "ping")).status;
    expect(last).toBe(429);
  });
});

describe("server baskets and the inbox", () => {
  async function putBasket(sub: string, body: Record<string, unknown>) {
    const { csrf } = await agentConfig(sub);
    return app.request("/api/agent/basket", as(sub, { method: "PUT", body: JSON.stringify({ repo: "default", branch: "main", csrf, ...body }) }));
  }

  const status = (to: string): Edit => ({ kind: "setStatus", id: "acme-001", from: "done", to });
  const priority: Edit = { kind: "setPriority", id: "acme-002", from: "p1", to: "p0" };

  it("fast-forwards, then merges a stale writer by edit key", async () => {
    const first = await putBasket("ada", { edits: [status("review")], baseUpdated: 0, changedKeys: [editKey(status("review"))], removedKeys: [] });
    const firstBody = (await first.json()) as { updated: number; merged: boolean };
    expect(firstBody.merged).toBe(false);

    // Device B, synced at `firstBody.updated`, adds a priority edit.
    const second = await putBasket("ada", {
      edits: [status("review"), priority],
      baseUpdated: firstBody.updated,
      changedKeys: [editKey(priority)],
      removedKeys: [],
    });
    const secondBody = (await second.json()) as { updated: number };

    // Device A still at `firstBody.updated` moves the status again: merged, B's edit survives.
    const third = await putBasket("ada", {
      edits: [status("idea")],
      baseUpdated: firstBody.updated,
      changedKeys: [editKey(status("idea"))],
      removedKeys: [],
    });
    const thirdBody = (await third.json()) as { edits: Edit[]; merged: boolean; updated: number };
    expect(thirdBody.merged).toBe(true);
    expect(thirdBody.edits).toEqual([status("idea"), priority]);
    expect(thirdBody.updated).toBeGreaterThan(secondBody.updated);

    // A stale removal drops only that key.
    const fourth = await putBasket("ada", { edits: [], baseUpdated: firstBody.updated, changedKeys: [], removedKeys: [editKey(status("idea"))] });
    expect(((await fourth.json()) as { edits: Edit[] }).edits).toEqual([priority]);

    const grace = await app.request("/api/agent/basket?repo=default&branch=main", as("grace"));
    expect(((await grace.json()) as { edits: Edit[] }).edits).toEqual([]);
    const invalid = await putBasket("ada", { edits: [{ kind: "nope" }], baseUpdated: 0, changedKeys: [], removedKeys: [] });
    expect(invalid.status).toBe(400);
  });

  it("accepts a proposal into the basket, rejects another, and keeps users apart", async () => {
    const token = await newToken("ada");
    const one = data(await call(token, "propose_edits", { repo: "default", branch: "main", edits: [{ kind: "setStatus", id: "acme-002", to: "review" }] })) as {
      proposalId: string;
    };
    const two = data(await call(token, "propose_edits", { repo: "default", branch: "main", edits: [{ kind: "setPriority", id: "acme-002", to: "p0" }] })) as {
      proposalId: string;
    };
    const listed = (await (await app.request("/api/agent/proposals?status=pending", as("ada"))).json()) as { proposals: { id: string }[] };
    expect(listed.proposals.map((proposal) => proposal.id).sort()).toEqual([one.proposalId, two.proposalId].sort());
    expect(((await (await app.request("/api/agent/proposals", as("grace"))).json()) as { proposals: unknown[] }).proposals).toEqual([]);

    const graceCsrf = (await agentConfig("grace")).csrf;
    const stolen = await app.request(`/api/agent/proposals/${one.proposalId}/accept`, as("grace", { method: "POST", body: JSON.stringify({ csrf: graceCsrf }) }));
    expect(stolen.status).toBe(404);

    const { csrf } = await agentConfig("ada");
    const accept = await app.request(`/api/agent/proposals/${one.proposalId}/accept`, as("ada", { method: "POST", body: JSON.stringify({ csrf }) }));
    expect(accept.status).toBe(200);
    const acceptBody = (await accept.json()) as { basket: { edits: Edit[] } };
    expect(acceptBody.basket.edits).toEqual([{ kind: "setStatus", id: "acme-002", from: "in-progress", to: "review" }]);
    const twice = await app.request(`/api/agent/proposals/${one.proposalId}/accept`, as("ada", { method: "POST", body: JSON.stringify({ csrf }) }));
    expect(twice.status).toBe(409);

    const reject = await app.request(`/api/agent/proposals/${two.proposalId}/reject`, as("ada", { method: "POST", body: JSON.stringify({ csrf }) }));
    expect(reject.status).toBe(200);
    expect(db.getProposal("github:ada", two.proposalId)?.status).toBe("rejected");
    const basket = data(await call(token, "get_basket", { repo: "default", branch: "main" })) as { count: number };
    expect(basket.count).toBe(1);
  });

  it("accepts all pending proposals oldest first", async () => {
    const token = await newToken("ada");
    await call(token, "propose_edits", { repo: "default", branch: "main", edits: [{ kind: "setStatus", id: "acme-002", to: "review" }] });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await call(token, "propose_edits", { repo: "default", branch: "main", edits: [{ kind: "setStatus", id: "acme-002", to: "done" }] });
    const { csrf } = await agentConfig("ada");
    const all = await app.request("/api/agent/proposals/accept-all", as("ada", { method: "POST", body: JSON.stringify({ csrf, repo: "default" }) }));
    expect(((await all.json()) as { accepted: string[] }).accepted).toHaveLength(2);
    // The later proposal wins, with the value the board showed first.
    expect(db.getBasket("github:ada", "default", "main").edits).toEqual([{ kind: "setStatus", id: "acme-002", from: "in-progress", to: "done" }]);
  });
});

describe("live events", () => {
  async function readEvents(response: Response, count: number): Promise<{ event: string; data: Record<string, unknown> }[]> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const events: { event: string; data: Record<string, unknown> }[] = [];
    let buffer = "";
    while (events.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split = buffer.indexOf("\n\n");
      while (split !== -1) {
        const chunk = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const event = /^event: (.+)$/m.exec(chunk)?.[1];
        const payload = /^data: (.+)$/m.exec(chunk)?.[1];
        if (event !== undefined && payload !== undefined) events.push({ event, data: JSON.parse(payload) as Record<string, unknown> });
        split = buffer.indexOf("\n\n");
      }
    }
    await reader.cancel();
    return events;
  }

  it("needs a session and delivers proposals and basket changes only to their owner", async () => {
    expect((await app.request("/api/events")).status).toBe(401);
    const token = await newToken("ada");
    const controller = new AbortController();
    const ada = await app.request("/api/events", as("ada", { signal: controller.signal }));
    expect(ada.status).toBe(200);
    expect(ada.headers.get("content-type")).toContain("text/event-stream");
    const graceController = new AbortController();
    const grace = await app.request("/api/events", as("grace", { signal: graceController.signal }));
    await vi.waitFor(() => expect(openStreams()).toBe(2));

    const reading = readEvents(ada, 3);
    const proposed = data(await call(token, "propose_edits", { repo: "default", branch: "main", edits: [{ kind: "setStatus", id: "acme-002", to: "review" }] })) as {
      proposalId: string;
    };
    const { csrf } = await agentConfig("ada");
    await app.request(`/api/agent/proposals/${proposed.proposalId}/accept`, as("ada", { method: "POST", body: JSON.stringify({ csrf }) }));
    const events = await reading;
    expect(events.map((event) => event.event)).toEqual(["ready", "proposal", "basket"]);
    expect(events[1]?.data).toMatchObject({ id: proposed.proposalId, status: "pending", repo: "default" });
    expect(events[2]?.data).toMatchObject({ repo: "default", branch: "main", source: "inbox" });

    const graceEvents = readEvents(grace, 2);
    seedStore({ ...(await import("../store.js")).getSnapshot()!, refs: [{ name: "main", sha: "f".repeat(40), isDefault: true } as never] }, (await import("../store.js")).getConfig()!);
    const seen = await graceEvents;
    expect(seen.map((event) => event.event)).toEqual(["ready", "snapshot"]);
    expect(seen[1]?.data).toMatchObject({ repo: "default", ref: null });
    controller.abort();
    graceController.abort();
  });
});
