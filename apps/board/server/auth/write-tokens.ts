import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Context } from "hono";
import { DEFAULT_WRITE_TOKEN_TTL_MS, getAuthConfig } from "./env.js";
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
 * GitHub write tokens live only here: AES-256-GCM encrypted, in process memory,
 * for `SNOBOARD_GITHUB_WRITE_TOKEN_TTL` (default 1h, at most 12h, never past the
 * session). The browser holds an opaque random handle in an httpOnly cookie
 * scoped to `/api`; the token itself never leaves the server.
 * With `SNOBOARD_GITHUB_WRITE_TOKEN_STORE=encrypted-file` the encrypted entries are
 * also mirrored to one 0600 file in the data directory, sealed again with
 * AES-256-GCM under a second key derived from the session secret, so a restart
 * keeps them. Otherwise a restart (or a second replica) loses every token.
 */
export const WRITE_COOKIE = "snoboard_gh_write";
export const WRITE_COOKIE_PATH = "/api";
/** Default lifetime; the configured one is `writeTokenTtlMs()`. */
export const WRITE_TOKEN_TTL_MS = DEFAULT_WRITE_TOKEN_TTL_MS;
const MAX_ENTRIES = 10_000;
const HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HKDF_INFO = "snoboard-github-write-token-v1";
const FILE_HKDF_INFO = "snoboard-github-write-token-file-v1";
const FILE_VERSION = 1;
const FILE_AAD = Buffer.from(`${FILE_HKDF_INFO}\n${FILE_VERSION}`, "utf8");

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
/** Set by `bootWriteTokens` when the encrypted-file store is on. */
let persistence: { filePath: string; secret: Buffer } | null = null;

type Logger = { warn(message: string): void };
const defaultLogger: Logger = {
  warn(message) {
    console.warn(message);
  },
};
let logger: Logger = defaultLogger;

export function setWriteTokenLogger(next?: Logger): void {
  logger = next ?? defaultLogger;
}

/** Configured lifetime of a write token in ms. */
export function writeTokenTtlMs(): number {
  return getAuthConfig().writeTokenTtlMs ?? DEFAULT_WRITE_TOKEN_TTL_MS;
}

/**
 * Apply the token store from the auth config: memory (default) or the encrypted
 * file, loaded now. Expired, foreign or unreadable entries are dropped.
 */
export function bootWriteTokens(now = Date.now()): void {
  persistence = null;
  resetWriteTokens();
  const config = getAuthConfig();
  const store = config.writeTokenStore;
  if (store?.kind !== "encrypted-file") return;
  if (config.sessionSecret === undefined) {
    throw new Error("Invalid Snoboard auth environment: the encrypted-file write token store needs a session secret");
  }
  persistence = { filePath: store.filePath, secret: config.sessionSecret };
  loadFile(now);
}

/** Path of the encrypted token file, or null for the memory store. */
export function writeTokenFilePath(): string | null {
  return persistence?.filePath ?? null;
}

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
  const ttl = writeTokenTtlMs();
  const exp = Math.min(now + ttl, owner.expMs);
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
  persist(now);
  return { handle, maxAgeSeconds: Math.max(1, Math.min(Math.floor(ttl / 1000), Math.floor((exp - now) / 1000))) };
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
  const before = entries.size;
  if (owner !== null) dropSession(owner.key);
  const handle = readCookie(c.req.header("cookie"), WRITE_COOKIE);
  if (handle !== null && HANDLE_PATTERN.test(handle)) dropDigest(digestOf(handle));
  if (entries.size !== before) persist();
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
    persist(now);
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
    persist(now);
    return null;
  }
}

type FileEntry = {
  digest: string;
  bind: string;
  login: string;
  accessEmail?: string;
  exp: number;
  iv: string;
  ciphertext: string;
  tag: string;
};

/** Write every live entry, keyed by session key, as one sealed blob. Atomic: 0600 temp file, then rename. */
function persist(now = Date.now()): void {
  if (persistence === null) return;
  const { filePath, secret } = persistence;
  const body: Record<string, FileEntry> = {};
  for (const [digest, entry] of entries) {
    if (entry.exp <= now) continue;
    body[entry.sessionKey] = {
      digest,
      bind: entry.bind,
      login: entry.login,
      ...(entry.accessEmail === undefined ? {} : { accessEmail: entry.accessEmail }),
      exp: entry.exp,
      iv: entry.iv.toString("base64"),
      ciphertext: entry.ciphertext.toString("base64"),
      tag: entry.tag.toString("base64"),
    };
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", fileKeyFor(secret), iv);
  cipher.setAAD(FILE_AAD);
  const data = Buffer.concat([cipher.update(JSON.stringify(body), "utf8"), cipher.final()]);
  const sealed = JSON.stringify({
    v: FILE_VERSION,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  });
  const temp = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    writeFileSync(temp, sealed, { mode: 0o600, flag: "wx" });
    chmodSync(temp, 0o600);
    renameSync(temp, filePath);
  } catch (error) {
    rmSync(temp, { force: true });
    // Never the token or the path contents: only that persisting failed. Memory still holds the entries.
    logger.warn(`snoboard: could not write the GitHub write token file (${errorCode(error)})`);
  }
}

function loadFile(now: number): void {
  if (persistence === null) return;
  const { filePath, secret } = persistence;
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") logger.warn(`snoboard: the GitHub write token file is unreadable (${errorCode(error)}); starting empty`);
    return;
  }
  const body = openFile(secret, raw);
  if (body === null) {
    logger.warn("snoboard: the GitHub write token file could not be decrypted; starting empty");
    persist(now);
    return;
  }
  let dropped = false;
  for (const [sessionKey, value] of Object.entries(body)) {
    const entry = readFileEntry(value);
    if (entry === null || !DIGEST_PATTERN.test(sessionKey) || entry.exp <= now || entries.size >= MAX_ENTRIES) {
      dropped = true;
      continue;
    }
    entries.set(entry.digest, {
      sessionKey,
      bind: entry.bind,
      login: entry.login,
      ...(entry.accessEmail === undefined ? {} : { accessEmail: entry.accessEmail }),
      exp: entry.exp,
      iv: Buffer.from(entry.iv, "base64"),
      ciphertext: Buffer.from(entry.ciphertext, "base64"),
      tag: Buffer.from(entry.tag, "base64"),
    });
    bySession.set(sessionKey, entry.digest);
  }
  if (dropped) persist(now);
}

function openFile(secret: Buffer, raw: string): Record<string, unknown> | null {
  try {
    const sealed = JSON.parse(raw) as { v?: unknown; iv?: unknown; tag?: unknown; data?: unknown };
    if (sealed.v !== FILE_VERSION) return null;
    if (typeof sealed.iv !== "string" || typeof sealed.tag !== "string" || typeof sealed.data !== "string") return null;
    const decipher = createDecipheriv("aes-256-gcm", fileKeyFor(secret), Buffer.from(sealed.iv, "base64"));
    decipher.setAAD(FILE_AAD);
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]).toString("utf8");
    const body: unknown = JSON.parse(plain);
    if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readFileEntry(value: unknown): FileEntry | null {
  if (value === null || typeof value !== "object") return null;
  const { digest, bind, login, accessEmail, exp, iv, ciphertext, tag } = value as Record<string, unknown>;
  if (typeof digest !== "string" || !DIGEST_PATTERN.test(digest)) return null;
  if (typeof bind !== "string" || typeof login !== "string") return null;
  if (typeof exp !== "number" || !Number.isSafeInteger(exp)) return null;
  if (accessEmail !== undefined && typeof accessEmail !== "string") return null;
  if (typeof iv !== "string" || typeof ciphertext !== "string" || typeof tag !== "string") return null;
  return { digest, bind, login, ...(accessEmail === undefined ? {} : { accessEmail }), exp, iv, ciphertext, tag };
}

function fileKeyFor(secret: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), FILE_HKDF_INFO, 32));
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : "error";
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
