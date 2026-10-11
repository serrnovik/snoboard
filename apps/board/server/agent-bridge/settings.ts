import path from "node:path";
import type { Context } from "hono";
import type { AuthConfig } from "../auth/env.js";
import type { BoardEnv } from "../auth/middleware.js";
import { BridgeDb, DB_FILE_NAME } from "./db.js";

/**
 * The agent bridge (`SNOBOARD_AGENT_BRIDGE=true`): personal MCP tokens for people's own coding
 * agents, server-side baskets, a proposal inbox and live updates. Off by default; when off, every
 * route it adds answers 404 and no database file is created.
 */
export type AgentBridgeSettings = {
  enabled: true;
  /** `<SNOBOARD_STATE_DIR or SNOBOARD_DATA_DIR>/snoboard.db`. */
  dbFile: string;
  /** Password sign-in shares one bridge user (`SNOBOARD_AGENT_BRIDGE_PASSWORD_USER=shared`). */
  sharedPasswordUser: boolean;
  /** Browser origins allowed to call `/mcp` (normally none: agents send no Origin). */
  allowedOrigins: string[];
  /** URL agents connect to; shown in the setup snippets. */
  mcpUrl: string | undefined;
};

type BridgeState = { settings: AgentBridgeSettings; db: BridgeDb | null };

let state: BridgeState | null = null;

export function loadAgentBridgeSettings(env: NodeJS.ProcessEnv, auth: AuthConfig): AgentBridgeSettings | null {
  const flag = env.SNOBOARD_AGENT_BRIDGE?.trim().toLowerCase() ?? "";
  if (flag === "" || flag === "false") return null;
  if (flag !== "true") throw new Error("SNOBOARD_AGENT_BRIDGE must be true or false");
  if (auth.modes.includes("none")) {
    throw new Error("SNOBOARD_AGENT_BRIDGE needs a signed-in identity; it cannot run with SNOBOARD_AUTH_MODES=none");
  }
  const passwordUser = env.SNOBOARD_AGENT_BRIDGE_PASSWORD_USER?.trim() ?? "";
  if (passwordUser !== "" && passwordUser !== "shared" && passwordUser !== "refuse") {
    throw new Error("SNOBOARD_AGENT_BRIDGE_PASSWORD_USER must be refuse or shared");
  }
  const sharedPasswordUser = passwordUser === "shared";
  const personal = auth.modes.includes("github") || auth.modes.includes("cloudflare-access");
  if (!personal && !sharedPasswordUser) {
    throw new Error(
      "SNOBOARD_AGENT_BRIDGE needs GitHub or Cloudflare Access sign-in (one identity per person); with password-only sign-in set SNOBOARD_AGENT_BRIDGE_PASSWORD_USER=shared to share one bridge user",
    );
  }
  const stateDir = (env.SNOBOARD_STATE_DIR?.trim() || env.SNOBOARD_DATA_DIR?.trim() || "/tmp/snoboard").trim();
  const allowedOrigins = (env.SNOBOARD_AGENT_BRIDGE_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      let url: URL;
      try {
        url = new URL(entry);
      } catch {
        throw new Error(`SNOBOARD_AGENT_BRIDGE_ALLOWED_ORIGINS: not an origin: ${entry}`);
      }
      if (url.origin !== entry.replace(/\/$/, "")) throw new Error(`SNOBOARD_AGENT_BRIDGE_ALLOWED_ORIGINS: not an origin: ${entry}`);
      return url.origin;
    });
  const explicit = env.SNOBOARD_AGENT_BRIDGE_MCP_URL?.trim();
  let mcpUrl: string | undefined;
  if (explicit !== undefined && explicit.length > 0) {
    const url = new URL(explicit);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("SNOBOARD_AGENT_BRIDGE_MCP_URL must be http(s)");
    mcpUrl = url.toString();
  } else if (auth.publicUrl !== undefined) {
    mcpUrl = `${new URL(auth.publicUrl).origin}/mcp`;
  }
  return {
    enabled: true,
    dbFile: path.join(stateDir, DB_FILE_NAME),
    sharedPasswordUser,
    allowedOrigins,
    mcpUrl,
  };
}

/** Reads the settings at boot. The database opens on first use. */
export function bootAgentBridge(env: NodeJS.ProcessEnv, auth: AuthConfig): void {
  const settings = loadAgentBridgeSettings(env, auth);
  state = settings === null ? null : { settings, db: null };
  if (settings !== null) console.info(`snoboard: agent bridge on db=${JSON.stringify(settings.dbFile)}`);
}

/** Tests: turn the bridge on with an in-memory (or given) database. */
export function setAgentBridge(settings: AgentBridgeSettings | null, db?: BridgeDb): void {
  state?.db?.close();
  state = settings === null ? null : { settings, db: db ?? null };
}

export function agentBridgeSettings(): AgentBridgeSettings | null {
  return state?.settings ?? null;
}

/** The open database, or null when the bridge is off. */
export function bridgeDb(): BridgeDb | null {
  if (state === null) return null;
  state.db ??= new BridgeDb(state.settings.dbFile);
  return state.db;
}

export type BridgeUser = { key: string; display: string };

/**
 * The stable person behind a board request: GitHub login, Cloudflare Access email, or (only with
 * `SNOBOARD_AGENT_BRIDGE_PASSWORD_USER=shared`) the one shared password user. Null otherwise.
 */
export function bridgeUser(c: Context<BoardEnv>): BridgeUser | null {
  const settings = agentBridgeSettings();
  if (settings === null) return null;
  const identity = c.get("identity");
  if (identity !== undefined && identity.email.length > 0) {
    const email = identity.email.toLowerCase();
    return { key: `email:${email}`, display: email };
  }
  const session = c.get("session");
  if (session?.method === "github" && session.sub.length > 0) {
    return { key: `github:${session.sub.toLowerCase()}`, display: session.sub };
  }
  if (session?.method === "password" && settings.sharedPasswordUser) {
    const name = process.env.SNOBOARD_PASSWORD_NAME?.trim() || "password-user";
    return { key: "password:shared", display: name };
  }
  return null;
}
