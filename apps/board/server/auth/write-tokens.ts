import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import type { Context } from "hono";
import { getAuthConfig } from "./env.js";
import type { BoardEnv, CloudflareAccessIdentity } from "./middleware.js";
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
  /** Who the board knows: the GitHub session login, or `cf:<email>` for Cloudflare Access. */
  bind: string;
  /** GitHub login the token belongs to (from GET /user for Access users). */
  login: string;
  accessEmail?: string;
  exp: number;
  iv: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
};

export type WriteToken = {
  token: string;
  login: string;
  /** Set for Cloudflare Access users: the Access email the token was connected under. */
  accessEmail?: string;
};

/** The board login a write token is tied to. */
export type WriteOwner = {
  key: string;
  bind: string;
  /** Epoch ms after which the owner's login is over. */
  expMs: number;
  accessEmail?: string;
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

export function ownerOfSession(claims: SessionClaims): WriteOwner {
  return { key: sessionKeyOf(claims), bind: claims.sub, expMs: claims.exp };
}

/**
 * One Cloudflare Access login: email, subject and the Access token's issue time.
 * Signing out of Access and back in yields a new token (new `iat`), so a new key:
 * the old write token is unreachable.
 */
export function ownerOfAccess(identity: CloudflareAccessIdentity): WriteOwner | null {
  if (identity.email.length === 0 || identity.exp === undefined) return null;
  const email = identity.email.toLowerCase();
  const key = createHash("sha256")
    .update(`cloudflare-access\n${email}\n${identity.sub ?? ""}\n${identity.iat ?? identity.exp}`)
    .digest("base64url");
  return { key, bind: `cf:${email}`, expMs: identity.exp * 1000, accessEmail: email };
}

/** Store `token` for this session and return the handle for the cookie. Replaces any earlier token. */
export function storeWriteToken(
  secret: Buffer,
  session: SessionClaims,
  token: string,
  now = Date.now(),
): { handle: string; maxAgeSeconds: number } {
  return storeOwnerWriteToken(secret, ownerOfSession(session), token, session.sub, now);
}

/** Store `token` (belonging to GitHub user `login`) for `owner`. Replaces any earlier token of that owner. */
export function storeOwnerWriteToken(
  secret: Buffer,
  owner: WriteOwner,
  token: string,
  login: string,
  now = Date.now(),
): { handle: string; maxAgeSeconds: number } {
  sweep(now);
  const sessionKey = owner.key;
  dropSession(sessionKey);
  if (entries.size >= MAX_ENTRIES) throw new Error("write token store is full");
  const handle = randomBytes(32).toString("base64url");
  const digest = digestOf(handle);
  const exp = Math.min(now + WRITE_TOKEN_TTL_MS, owner.expMs);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(secret), iv);
  cipher.setAAD(aadFor(digest, sessionKey, owner.bind, login));
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  entries.set(digest, {
    sessionKey,
    bind: owner.bind,
    login,
    ...(owner.accessEmail === undefined ? {} : { accessEmail: owner.accessEmail }),
    exp,
    iv,
    ciphertext,
    tag: cipher.getAuthTag(),
  });
  bySession.set(sessionKey, digest);
  return { handle, maxAgeSeconds: Math.max(1, Math.min(WRITE_TOKEN_TTL_SECONDS, Math.floor((exp - now) / 1000))) };
}

/**
 * The write token for this request's GitHub session or Cloudflare Access login,
 * or null. The handle must belong to the same owner that stored it.
 */
export function getWriteToken(c: Context<BoardEnv>, now = Date.now()): WriteToken | null {
  const secret = getAuthConfig().sessionSecret;
  const owner = ownerOf(c);
  if (secret === undefined || owner === null) return null;
  const handle = readCookie(c.req.header("cookie"), WRITE_COOKIE);
  if (handle === null || !HANDLE_PATTERN.test(handle)) return null;
  return openToken(secret, owner, handle, now);
}

/** Forget this session's write token (whatever handle the browser holds) and expire the cookie. */
export function clearWriteToken(c: Context<BoardEnv>): void {
  const owner = ownerOf(c, true);
  if (owner !== null) dropSession(owner.key);
  const handle = readCookie(c.req.header("cookie"), WRITE_COOKIE);
  if (handle !== null && HANDLE_PATTERN.test(handle)) dropDigest(digestOf(handle));
  c.header("set-cookie", writeCookie("", 0), { append: true });
}

/** GitHub session (method github) or, on Access boards, the verified Access identity. */
function ownerOf(c: Context<BoardEnv>, anySession = false): WriteOwner | null {
  const identity = c.get("identity");
  if (identity !== undefined) return ownerOfAccess(identity);
  const session = c.get("session") ?? readSessionCookie(c);
  if (session === null) return null;
  if (!anySession && session.method !== "github") return null;
  return ownerOfSession(session);
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

function openToken(secret: Buffer, owner: WriteOwner, handle: string, now: number): WriteToken | null {
  const digest = digestOf(handle);
  const entry = entries.get(digest);
  if (entry === undefined) return null;
  if (entry.exp <= now) {
    dropDigest(digest);
    return null;
  }
  if (entry.sessionKey !== owner.key || entry.bind !== owner.bind) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyFor(secret), entry.iv);
    decipher.setAAD(aadFor(digest, owner.key, owner.bind, entry.login));
    decipher.setAuthTag(entry.tag);
    const token = Buffer.concat([decipher.update(entry.ciphertext), decipher.final()]).toString("utf8");
    return entry.accessEmail === undefined
      ? { token, login: entry.login }
      : { token, login: entry.login, accessEmail: entry.accessEmail };
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

function aadFor(digest: string, sessionKey: string, bind: string, login: string): Buffer {
  return Buffer.from(`${digest}\n${sessionKey}\n${bind}\n${login}`, "utf8");
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
