import { randomBytes } from "node:crypto";
import { hash, hashSync, verify } from "@node-rs/argon2";
import { Hono, type Context } from "hono";
import { getAuthConfig, isArgon2idHash } from "./env.js";
import { renderAuthHtml, type BoardEnv } from "./middleware.js";
import {
  serializeCookie,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  SESSION_TTL_SECONDS,
  signSession,
  usesSecureCookie,
} from "./session.js";
import { clearWriteToken } from "./write-tokens.js";

export const PASSWORD_SUBJECT = "password";
export const PASSWORD_ATTEMPT_LIMIT = 5;
export const PASSWORD_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
export const ARGON2_OPTIONS = {
  // @node-rs/argon2 Algorithm.Argon2id. The const enum is not importable under verbatimModuleSyntax.
  algorithm: 2,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

const MAX_PASSWORD_LENGTH = 1024;
// Keeps a malformed hash on the same argon2id path. The password is random and is never accepted.
const DUMMY_PASSWORD_HASH = hashSync(randomBytes(32), ARGON2_OPTIONS);
const attempts = createWindowLimiter(PASSWORD_ATTEMPT_LIMIT, PASSWORD_ATTEMPT_WINDOW_MS);
export const PASSWORD_GLOBAL_ATTEMPT_LIMIT = 30;
const GLOBAL_KEY = "*";
const globalAttempts = createWindowLimiter(PASSWORD_GLOBAL_ATTEMPT_LIMIT, PASSWORD_ATTEMPT_WINDOW_MS);

export const passwordRouter = new Hono<BoardEnv>();

passwordRouter.post("/password", async (c) => {
  const config = getAuthConfig();
  const hashValue = config.passwordHash;
  const secret = config.sessionSecret;
  if (!config.modes.includes("password") || hashValue === undefined || secret === undefined) {
    return c.notFound();
  }
  setAuthResponseHeaders(c);
  const now = Date.now();
  const ip = clientAddress({ get: (name) => c.req.header(name) });
  if (beginPasswordAttempt(ip, now) === "limited") {
    c.header("Retry-After", String(passwordRetryAfterSeconds(ip, now)));
    return rejected(c, 429, "Too many attempts", "Too many sign-in attempts. Try again later.", {
      error: "too many attempts",
    });
  }
  const submitted = await readSubmittedPassword(c);
  const tooLong = submitted.length > MAX_PASSWORD_LENGTH;
  const matches = await passwordMatches(hashValue, tooLong ? "" : submitted);
  if (tooLong || !matches) {
    return rejected(c, 401, "Sign-in failed", "That password is incorrect.", { error: "invalid password" });
  }
  completePasswordSuccess(ip);
  const token = signSession(secret, {
    sub: PASSWORD_SUBJECT,
    method: "password",
    iat: now,
    exp: now + SESSION_TTL_MS,
  });
  c.header(
    "set-cookie",
    serializeCookie(SESSION_COOKIE, token, {
      maxAge: SESSION_TTL_SECONDS,
      path: "/",
      secure: usesSecureCookie(config.publicUrl),
    }),
  );
  if (isFormSubmission(c)) return c.redirect("/", 302);
  return c.json({ ok: true });
});

// Logout clears the session cookie. Sessions are stateless, so rotating
// SNOBOARD_SESSION_SECRET is how an operator revokes every session at once.
passwordRouter.post("/logout", (c) => {
  const config = getAuthConfig();
  setAuthResponseHeaders(c);
  // Drop any GitHub write token held for this session before the cookie goes.
  clearWriteToken(c);
  c.header(
    "set-cookie",
    serializeCookie(SESSION_COOKIE, "", { maxAge: 0, path: "/", secure: usesSecureCookie(config.publicUrl) }),
    { append: true },
  );
  if (isFormSubmission(c)) return c.redirect("/login", 302);
  return c.json({ ok: true });
});

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export async function passwordMatches(storedHash: string, password: string): Promise<boolean> {
  const usable = isArgon2idHash(storedHash);
  try {
    const matches = await verify(usable ? storedHash : DUMMY_PASSWORD_HASH, password);
    if (!usable) return false;
    return matches;
  } catch {
    try {
      await verify(DUMMY_PASSWORD_HASH, password);
    } catch {
      return false;
    }
    return false;
  }
}

export function beginPasswordAttempt(ip: string, now: number): "ok" | "limited" {
  // Per-client limit, plus a global cap: client addresses come from proxy
  // headers, which a client can vary to dodge the per-client limit.
  if (!attempts.allowed(ip, now) || !globalAttempts.allowed(GLOBAL_KEY, now)) return "limited";
  attempts.record(ip, now);
  globalAttempts.record(GLOBAL_KEY, now);
  return "ok";
}

export function completePasswordSuccess(ip: string): void {
  attempts.forgive(ip);
  globalAttempts.forgive(GLOBAL_KEY);
}

export function passwordRetryAfterSeconds(ip: string, now: number): number {
  return attempts.retryAfterSeconds(ip, now);
}

export function resetPasswordAttempts(): void {
  attempts.reset();
  globalAttempts.reset();
}

// The nearest proxy must overwrite X-Forwarded-For. The first address is the client key.
export function clientAddress(headers: { get(name: string): string | undefined }): string {
  const real = headers.get("x-real-ip")?.trim() ?? "";
  if (validAddress(real)) return real;
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded !== undefined) {
    const first = forwarded.split(",")[0]?.trim() ?? "";
    if (validAddress(first)) return first;
  }
  return "local";
}

async function readSubmittedPassword(c: Context<BoardEnv>): Promise<string> {
  const advertised = c.req.header("content-length");
  if (advertised !== undefined && Number(advertised) > 8192) return "";
  const type = c.req.header("content-type") ?? "";
  if (type.includes("application/json")) {
    const body: unknown = await c.req.json().catch(() => null);
    return passwordField(body);
  }
  const body: unknown = await c.req.parseBody().catch(() => null);
  return passwordField(body);
}

function passwordField(body: unknown): string {
  if (body === null || typeof body !== "object") return "";
  const password = (body as { password?: unknown }).password;
  if (typeof password !== "string") return "";
  return password;
}

function rejected(
  c: Context<BoardEnv>,
  status: 401 | 429,
  title: string,
  message: string,
  json: { error: string },
): Response {
  if (isFormSubmission(c)) return c.html(renderAuthHtml(title, message), status);
  return c.json(json, status);
}

function isFormSubmission(c: Context<BoardEnv>): boolean {
  const type = c.req.header("content-type") ?? "";
  return type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data");
}

function setAuthResponseHeaders(c: Context<BoardEnv>): void {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
}

function validAddress(value: string): boolean {
  if (value.length === 0 || value.length > 64) return false;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) return true;
  return /^[0-9a-fA-F:]+$/.test(value);
}

function createWindowLimiter(limit: number, windowMs: number) {
  const events = new Map<string, number[]>();

  function kept(key: string, now: number): number[] {
    const current = events.get(key) ?? [];
    const fresh = current.filter((stamp) => now - stamp < windowMs);
    if (fresh.length === 0) events.delete(key);
    else events.set(key, fresh);
    return fresh;
  }

  function sweep(now: number): void {
    if (events.size < 1024) return;
    for (const key of events.keys()) kept(key, now);
  }

  return {
    reset(): void {
      events.clear();
    },
    allowed(key: string, now: number): boolean {
      sweep(now);
      const fresh = kept(key, now);
      if (fresh.length >= limit) return false;
      if (fresh.length === 0 && events.size >= 10_000) return false;
      return true;
    },
    record(key: string, now: number): void {
      const fresh = kept(key, now);
      fresh.push(now);
      events.set(key, fresh);
    },
    forgive(key: string): void {
      const fresh = events.get(key);
      if (fresh === undefined) return;
      fresh.pop();
      if (fresh.length === 0) events.delete(key);
    },
    retryAfterSeconds(key: string, now: number): number {
      const fresh = kept(key, now);
      const oldest = fresh[0];
      if (oldest === undefined) return 1;
      return Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    },
  };
}
