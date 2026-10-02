import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import type { Context } from "hono";
import { getAuthConfig } from "./env.js";
import type { BoardEnv } from "./middleware.js";
import {
  readCookie,
  SESSION_COOKIE,
  serializeCookie,
  usesSecureCookie,
  verifySession,
  type SessionClaims,
} from "./session.js";

/**
 * GitHub write tokens live only here: encrypted, in process memory, for at
 * most an hour. The browser holds an opaque random handle in an httpOnly
 * cookie scoped to `/api`; the token itself never leaves the server.
 * A restart (or a second replica) loses every token; users reconnect.
 */
export const WRITE_COOKIE = "snoboard_gh_write";
export const WRITE_COOKIE_PATH = "/api";
export const WRITE_TOKEN_TTL_MS = 60 * 60 * 1000;
const WRITE_TOKEN_TTL_SECONDS = WRITE_TOKEN_TTL_MS / 1000;
const MAX_ENTRIES = 10_000;
const HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HKDF_INFO = "snoboard-github-write-token-v1";

type Entry = {
  sessionKey: string;
  login: string;
  exp: number;
  iv: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
};

export type WriteToken = {
  token: string;
  login: string;
};

/** Keyed by sha256(handle), so a lookup never compares raw handles. */
const entries = new Map<string, Entry>();
/** One token per session: sessionKey -> handle digest. */
const bySession = new Map<string, string>();

/** Stable id of one signed session (same cookie, same key; a new login is a new key). */
export function sessionKeyOf(claims: SessionClaims): string {
  return createHash("sha256")
    .update(`${claims.method}\n${claims.sub}\n${claims.iat}\n${claims.exp}`)
    .digest("base64url");
}

/** Store `token` for this session and return the handle for the cookie. Replaces any earlier token. */
export function storeWriteToken(
  secret: Buffer,
  session: SessionClaims,
  token: string,
  now = Date.now(),
): { handle: string; maxAgeSeconds: number } {
  sweep(now);
  const sessionKey = sessionKeyOf(session);
  dropSession(sessionKey);
  if (entries.size >= MAX_ENTRIES) throw new Error("write token store is full");
  const handle = randomBytes(32).toString("base64url");
  const digest = digestOf(handle);
  const exp = Math.min(now + WRITE_TOKEN_TTL_MS, session.exp);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(secret), iv);
  cipher.setAAD(aadFor(digest, sessionKey, session.sub));
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  entries.set(digest, { sessionKey, login: session.sub, exp, iv, ciphertext, tag: cipher.getAuthTag() });
  bySession.set(sessionKey, digest);
  return { handle, maxAgeSeconds: Math.max(1, Math.min(WRITE_TOKEN_TTL_SECONDS, Math.floor((exp - now) / 1000))) };
}

/**
 * The write token for this request's GitHub session, or null. The handle must
 * belong to the same signed session and the same login that stored it.
 */
export function getWriteToken(c: Context<BoardEnv>, now = Date.now()): WriteToken | null {
  const secret = getAuthConfig().sessionSecret;
  const session = c.get("session") ?? readSessionCookie(c);
  if (secret === undefined || session === null || session.method !== "github") return null;
  const handle = readCookie(c.req.header("cookie"), WRITE_COOKIE);
  if (handle === null || !HANDLE_PATTERN.test(handle)) return null;
  return openToken(secret, session, handle, now);
}

/** Forget this session's write token (whatever handle the browser holds) and expire the cookie. */
export function clearWriteToken(c: Context<BoardEnv>): void {
  const session = c.get("session") ?? readSessionCookie(c);
  if (session !== null) dropSession(sessionKeyOf(session));
  const handle = readCookie(c.req.header("cookie"), WRITE_COOKIE);
  if (handle !== null && HANDLE_PATTERN.test(handle)) dropDigest(digestOf(handle));
  c.header("set-cookie", writeCookie("", 0), { append: true });
}

export function writeCookie(handle: string, maxAgeSeconds: number): string {
  return serializeCookie(WRITE_COOKIE, handle, {
    maxAge: maxAgeSeconds,
    path: WRITE_COOKIE_PATH,
    secure: usesSecureCookie(getAuthConfig().publicUrl),
  });
}

export function resetWriteTokens(): void {
  entries.clear();
  bySession.clear();
}

/** Test hook: how many tokens are held. */
export function writeTokenCount(): number {
  return entries.size;
}

/** Test hook: the raw stored bytes, to prove the token is not kept in clear. */
export function storedWriteTokenBytes(): Buffer[] {
  return [...entries.values()].map((entry) => Buffer.concat([entry.iv, entry.ciphertext, entry.tag]));
}

function openToken(secret: Buffer, session: SessionClaims, handle: string, now: number): WriteToken | null {
  const digest = digestOf(handle);
  const entry = entries.get(digest);
  if (entry === undefined) return null;
  if (entry.exp <= now) {
    dropDigest(digest);
    return null;
  }
  const sessionKey = sessionKeyOf(session);
  if (entry.sessionKey !== sessionKey || entry.login !== session.sub) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyFor(secret), entry.iv);
    decipher.setAAD(aadFor(digest, sessionKey, session.sub));
    decipher.setAuthTag(entry.tag);
    const token = Buffer.concat([decipher.update(entry.ciphertext), decipher.final()]).toString("utf8");
    return { token, login: entry.login };
  } catch {
    dropDigest(digest);
    return null;
  }
}

function readSessionCookie(c: Context<BoardEnv>): SessionClaims | null {
  const secret = getAuthConfig().sessionSecret;
  if (secret === undefined) return null;
  const token = readCookie(c.req.header("cookie"), SESSION_COOKIE);
  if (token === null) return null;
  return verifySession(secret, token, Date.now());
}

function keyFor(secret: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), HKDF_INFO, 32));
}

function aadFor(digest: string, sessionKey: string, login: string): Buffer {
  return Buffer.from(`${digest}\n${sessionKey}\n${login}`, "utf8");
}

function digestOf(handle: string): string {
  return createHash("sha256").update(handle).digest("base64url");
}

function dropSession(sessionKey: string): void {
  const digest = bySession.get(sessionKey);
  if (digest !== undefined) dropDigest(digest);
}

function dropDigest(digest: string): void {
  const entry = entries.get(digest);
  if (entry === undefined) return;
  entries.delete(digest);
  if (bySession.get(entry.sessionKey) === digest) bySession.delete(entry.sessionKey);
}

function sweep(now: number): void {
  for (const [digest, entry] of entries) {
    if (entry.exp <= now) dropDigest(digest);
  }
}
