import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "snoboard_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000;

const CLOCK_SKEW_MS = 5 * 60 * 1000;
const SUBJECT_PATTERN = /^[A-Za-z0-9._@-]{1,64}$/;

export type SessionMethod = "password" | "github";

export type SessionClaims = {
  sub: string;
  method: SessionMethod;
  iat: number;
  exp: number;
};

export function usesSecureCookie(publicUrl: string | undefined): boolean {
  if (publicUrl === undefined) return true;
  try {
    const url = new URL(publicUrl);
    if (url.protocol === "http:" && url.hostname === "localhost") return false;
  } catch {
    return true;
  }
  return true;
}

export function serializeCookie(
  name: string,
  value: string,
  options: { maxAge: number; path: string; secure: boolean },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${options.maxAge}`,
  ];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined || header.length === 0 || header.length > 8192) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const raw = part.slice(separator + 1).trim();
    if (raw.length === 0) return null;
    try {
      return decodeURIComponent(raw);
    } catch {
      return null;
    }
  }
  return null;
}

export function signEncoded(secret: Buffer, encodedPayload: string): string {
  const signature = createHmac("sha256", secret).update(encodedPayload).digest("base64url");
  return `${encodedPayload}.${signature}`;
}

export function openEncoded(secret: Buffer, token: string): string | null {
  if (token.length === 0 || token.length > 4096) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const encodedPayload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(encodedPayload)) return null;
  const expected = createHmac("sha256", secret).update(encodedPayload).digest();
  const actual = decodeBase64Url(signature);
  if (actual === null || actual.length !== expected.length) return null;
  if (!timingSafeEqual(actual, expected)) return null;
  return encodedPayload;
}

export function signSession(secret: Buffer, claims: SessionClaims): string {
  const encoded = Buffer.from(
    JSON.stringify({
      sub: claims.sub,
      method: claims.method,
      iat: claims.iat,
      exp: claims.exp,
    }),
  ).toString("base64url");
  return signEncoded(secret, encoded);
}

export function verifySession(secret: Buffer, token: string, now = Date.now()): SessionClaims | null {
  const encoded = openEncoded(secret, token);
  if (encoded === null) return null;
  return parseClaims(encoded, now);
}

export function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  if (leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}

function parseClaims(encoded: string, now: number): SessionClaims | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const sub = record.sub;
  const method = record.method;
  const iat = record.iat;
  const exp = record.exp;
  if (typeof sub !== "string" || !SUBJECT_PATTERN.test(sub)) return null;
  if (method !== "password" && method !== "github") return null;
  if (typeof iat !== "number" || typeof exp !== "number") return null;
  if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp)) return null;
  if (exp <= iat || exp - iat > SESSION_TTL_MS) return null;
  if (exp <= now || iat > now + CLOCK_SKEW_MS) return null;
  return { sub, method, iat, exp };
}

function decodeBase64Url(value: string): Buffer | null {
  if (value.length === 0 || value.length > 4096) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length === 0) return null;
  // Reject non-canonical encodings (e.g. altered padding bits in the last char)
  // so each signature has exactly one accepted spelling.
  if (bytes.toString("base64url") !== value) return null;
  return bytes;
}
