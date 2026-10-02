import { createPublicKey, verify, type JsonWebKey, type KeyObject } from "node:crypto";
import type { CloudflareAccessConfig } from "./env.js";

const CERT_TTL_MS = 60 * 60 * 1000;
const UNKNOWN_KID_REFETCH_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;
const CLOCK_SKEW_SECONDS = 60;
const MAX_TOKEN_LENGTH = 8_192;
const MAX_JWKS_BYTES = 1_000_000;
const MAX_KEYS = 16;
const MAX_GROUPS = 32;

const EMAIL_PATTERN = /^[a-z0-9._%+-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const SUBJECT_PATTERN = /^[\x21-\x7E]{1,256}$/;
const KID_PATTERN = /^[\x21-\x7E]{1,256}$/;
const GROUP_PATTERN = /^[\x20-\x7E]{1,128}$/;

export type AccessIdentity = {
  email: string;
  sub: string;
  groups?: readonly string[];
};

export type AccessJwtCode =
  | "malformed"
  | "algorithm"
  | "unknown-kid"
  | "signature"
  | "audience"
  | "issuer"
  | "expired"
  | "not-yet-valid"
  | "claims"
  | "not-allowed"
  | "certs";

/** `iat`/`exp` of the Access token (seconds), so a write token can be tied to this Access login. */
export type AccessTokenTimes = { iat?: number; exp: number };

export type AccessJwtResult =
  | { ok: true; identity: AccessIdentity; token: AccessTokenTimes }
  | { ok: false; code: AccessJwtCode };

type CertCache = {
  keys: ReadonlyMap<string, KeyObject>;
  fetchedAt: number;
  unknownKidFetchedAt: number;
};

type RsaPublicJwk = JsonWebKey & { kid: string };

const certCaches = new Map<string, CertCache>();
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let cacheEpoch = 0;

export function startAccessCertRefresh(config: CloudflareAccessConfig): void {
  stopAccessCertRefresh();
  void refreshCerts(config, Date.now(), "ttl");
  refreshTimer = setInterval(() => {
    void refreshCerts(config, Date.now(), "ttl");
  }, CERT_TTL_MS);
  refreshTimer.unref();
}

export function stopAccessCertRefresh(): void {
  if (refreshTimer === undefined) return;
  clearInterval(refreshTimer);
  refreshTimer = undefined;
}

export function resetAccessKeyCache(): void {
  stopAccessCertRefresh();
  cacheEpoch += 1;
  certCaches.clear();
}

export async function verifyAccessJwt(
  token: string,
  config: CloudflareAccessConfig,
  now: number,
): Promise<AccessJwtResult> {
  const parsed = parseToken(token);
  if (parsed === null) return failure("malformed");
  if (parsed.alg !== "RS256") return failure("algorithm");
  const lookup = await lookupKey(config, parsed.kid, now);
  if (!lookup.ok) return failure(lookup.code);
  if (!signatureValid(parsed.signingInput, parsed.signature, lookup.key)) return failure("signature");
  return claimsResult(parsed.payload, config, now);
}

function failure(code: AccessJwtCode): AccessJwtResult {
  return { ok: false, code };
}

type ParsedToken = {
  alg: string;
  kid: string;
  signingInput: string;
  signature: string;
  payload: Record<string, unknown>;
};

function parseToken(token: string): ParsedToken | null {
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const encodedHeader = parts[0] ?? "";
  const encodedPayload = parts[1] ?? "";
  const signature = parts[2] ?? "";
  const header = decodeJson(encodedHeader);
  const payload = decodeJson(encodedPayload);
  if (header === null || payload === null) return null;
  if (typeof header.alg !== "string" || typeof header.kid !== "string") return null;
  if (!KID_PATTERN.test(header.kid)) return null;
  return {
    alg: header.alg,
    kid: header.kid,
    signingInput: `${encodedHeader}.${encodedPayload}`,
    signature,
    payload,
  };
}

function decodeJson(encoded: string): Record<string, unknown> | null {
  const bytes = decodeBase64Url(encoded);
  if (bytes === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function decodeBase64Url(value: string): Buffer | null {
  if (value.length === 0 || value.length > MAX_TOKEN_LENGTH) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length === 0) return null;
  return bytes;
}

async function lookupKey(
  config: CloudflareAccessConfig,
  kid: string,
  now: number,
): Promise<{ ok: true; key: KeyObject } | { ok: false; code: "unknown-kid" | "certs" }> {
  let cache = certCaches.get(config.teamDomain);
  const fresh = cache !== undefined && now - cache.fetchedAt < CERT_TTL_MS;
  if (!fresh) {
    // Keep serving the previous keys when a refresh fails; only a cold cache is fatal.
    const updated = await refreshCerts(config, now, "ttl");
    if (updated !== null) cache = updated;
  }
  if (cache === undefined) return { ok: false, code: "certs" };
  const cached = cache.keys.get(kid);
  if (cached !== undefined) return { ok: true, key: cached };
  if (now - cache.unknownKidFetchedAt < UNKNOWN_KID_REFETCH_MS) return { ok: false, code: "unknown-kid" };
  const rotated = await refreshCerts(config, now, "kid");
  if (rotated === null) {
    // Throttle kid refetches even when the fetch fails.
    certCaches.set(config.teamDomain, { ...cache, unknownKidFetchedAt: now });
    return { ok: false, code: "certs" };
  }
  const key = rotated.keys.get(kid);
  if (key === undefined) return { ok: false, code: "unknown-kid" };
  return { ok: true, key };
}

async function refreshCerts(
  config: CloudflareAccessConfig,
  now: number,
  reason: "ttl" | "kid",
): Promise<CertCache | null> {
  const epoch = cacheEpoch;
  const keys = await fetchKeys(config);
  if (keys === null || epoch !== cacheEpoch) return null;
  const previous = certCaches.get(config.teamDomain);
  const entry: CertCache = {
    keys,
    fetchedAt: now,
    unknownKidFetchedAt: reason === "kid" ? now : (previous?.unknownKidFetchedAt ?? Number.NEGATIVE_INFINITY),
  };
  certCaches.set(config.teamDomain, entry);
  return entry;
}

async function fetchKeys(config: CloudflareAccessConfig): Promise<ReadonlyMap<string, KeyObject> | null> {
  const url = `https://${config.teamDomain}/cdn-cgi/access/certs`;
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > MAX_JWKS_BYTES) return null;
  let text: string;
  try {
    text = await response.text();
  } catch {
    return null;
  }
  if (text.length === 0 || text.length > MAX_JWKS_BYTES) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  return readJwks(payload);
}

function readJwks(payload: unknown): ReadonlyMap<string, KeyObject> {
  const keys = new Map<string, KeyObject>();
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return keys;
  const list = (payload as { keys?: unknown }).keys;
  if (!Array.isArray(list)) return keys;
  for (const entry of list) {
    if (keys.size >= MAX_KEYS) break;
    const jwk = readRsaJwk(entry);
    if (jwk === null || keys.has(jwk.kid)) continue;
    try {
      keys.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
    } catch {
      continue;
    }
  }
  return keys;
}

function readRsaJwk(entry: unknown): RsaPublicJwk | null {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;
  if (record.kty !== "RSA") return null;
  if (typeof record.n !== "string" || typeof record.e !== "string" || typeof record.kid !== "string") return null;
  if (!KID_PATTERN.test(record.kid) || record.n.length === 0 || record.e.length === 0) return null;
  return { kty: "RSA", n: record.n, e: record.e, kid: record.kid, alg: "RS256", use: "sig" };
}

function signatureValid(signingInput: string, encodedSignature: string, key: KeyObject): boolean {
  const signature = decodeBase64Url(encodedSignature);
  if (signature === null) return false;
  try {
    return verify("RSA-SHA256", Buffer.from(signingInput, "utf8"), key, signature);
  } catch {
    return false;
  }
}

function claimsResult(payload: Record<string, unknown>, config: CloudflareAccessConfig, now: number): AccessJwtResult {
  if (!audienceAllowed(payload.aud, config.audiences)) return failure("audience");
  if (payload.iss !== `https://${config.teamDomain}`) return failure("issuer");
  const lifetime = lifetimeAllowed(payload.exp, payload.nbf, now);
  if (lifetime !== "ok") return failure(lifetime);
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!EMAIL_PATTERN.test(email)) return failure("claims");
  if (typeof payload.sub !== "string" || !SUBJECT_PATTERN.test(payload.sub)) return failure("claims");
  const groups = readGroups(payload.groups);
  if (groups === null) return failure("claims");
  if (!identityAllowed(email, groups, config)) {
    console.info(`Cloudflare Access denied for ${email}`);
    return failure("not-allowed");
  }
  const identity: AccessIdentity = groups.length === 0 ? { email, sub: payload.sub } : { email, sub: payload.sub, groups };
  const exp = payload.exp as number;
  const iat = typeof payload.iat === "number" && Number.isSafeInteger(payload.iat) ? payload.iat : undefined;
  return { ok: true, identity, token: iat === undefined ? { exp } : { iat, exp } };
}

function audienceAllowed(aud: unknown, allowed: readonly string[]): boolean {
  const values = typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud : [];
  for (const value of values) {
    if (typeof value === "string" && allowed.includes(value)) return true;
  }
  return false;
}

function lifetimeAllowed(exp: unknown, nbf: unknown, now: number): "ok" | "expired" | "not-yet-valid" | "claims" {
  if (typeof exp !== "number" || !Number.isSafeInteger(exp)) return "claims";
  if (nbf !== undefined && (typeof nbf !== "number" || !Number.isSafeInteger(nbf))) return "claims";
  if (typeof nbf === "number" && exp < nbf) return "claims";
  const nowSeconds = Math.floor(now / 1000);
  if (exp < nowSeconds - CLOCK_SKEW_SECONDS) return "expired";
  if (typeof nbf === "number" && nbf > nowSeconds + CLOCK_SKEW_SECONDS) return "not-yet-valid";
  return "ok";
}

function readGroups(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  if (value.length > MAX_GROUPS) return null;
  const groups: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    const group = entry.trim().toLowerCase();
    if (!GROUP_PATTERN.test(entry.trim()) || group.length === 0) return null;
    if (!groups.includes(group)) groups.push(group);
  }
  return groups;
}

function identityAllowed(email: string, groups: readonly string[], config: CloudflareAccessConfig): boolean {
  if (config.allowedEmails.includes(email)) return true;
  const at = email.lastIndexOf("@");
  const domain = at === -1 ? "" : email.slice(at + 1);
  if (domain.length > 0 && config.allowedEmailDomains.includes(domain)) return true;
  for (const group of groups) {
    if (config.allowedGroups.includes(group)) return true;
  }
  return false;
}
