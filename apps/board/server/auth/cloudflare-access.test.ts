import { createHmac, createPublicKey, createSign, generateKeyPairSync, type JsonWebKey, type KeyObject } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../index.js";
import { verifyAccessJwt, type AccessJwtResult } from "./cloudflare-access.js";
import { bootAuth, resetAuthConfig, setAuthConfig, type CloudflareAccessConfig } from "./env.js";

const NOW = 1_700_000_000_000;
const TEAM = "example.cloudflareaccess.com";
const CERTS_URL = `https://${TEAM}/cdn-cgi/access/certs`;

const access: CloudflareAccessConfig = {
  teamDomain: TEAM,
  audiences: ["audience-tag", "second-tag"],
  allowedEmails: ["ada@example.com"],
  allowedEmailDomains: ["example.com"],
  allowedGroups: ["readers"],
};

type TestKey = {
  kid: string;
  privateKey: KeyObject;
  jwk: JsonWebKey & { kid: string };
};

let signing: TestKey;
let rotated: TestKey;

beforeAll(() => {
  signing = makeKey("key-a");
  rotated = makeKey("key-b");
});

beforeEach(() => {
  resetAuthConfig();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  resetAuthConfig();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("verifyAccessJwt", () => {
  it("accepts a valid RS256 token and reuses the cached certificate", async () => {
    const fetchMock = installCerts([[signing.jwk]]);
    const token = signRs256(signing, claims(NOW));
    const result = await verifyAccessJwt(token, access, NOW);
    expect(result).toMatchObject({ ok: true, identity: { email: "ada@example.com", sub: "user-1" } });

    const again = await verifyAccessJwt(token, access, NOW + 1_000);
    expect(again.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(CERTS_URL, expect.objectContaining({ signal: expect.any(AbortSignal) }));

    const seconds = Math.floor(NOW / 1000);
    const withinSkew = signRs256(signing, claims(NOW, { exp: seconds - 60, nbf: seconds - 120 }));
    expect((await verifyAccessJwt(withinSkew, access, NOW)).ok).toBe(true);
    const notBeforeSkew = signRs256(signing, claims(NOW, { nbf: seconds + 60 }));
    expect((await verifyAccessJwt(notBeforeSkew, access, NOW)).ok).toBe(true);

    const tampered = `${token.slice(0, -4)}${token.endsWith("aaaa") ? "bbbb" : "aaaa"}`;
    expect(await verifyAccessJwt(tampered, access, NOW)).toEqual({ ok: false, code: "signature" });
    expect(loggedText()).not.toContain(token);
    expect(loggedText()).not.toContain(tampered);
  });

  it("rejects the wrong audience", async () => {
    installCerts([[signing.jwk]]);
    const result = await verifyAccessJwt(signRs256(signing, claims(NOW, { aud: ["other-tag"] })), access, NOW);
    expect(result).toEqual({ ok: false, code: "audience" });
  });

  it("rejects the wrong issuer", async () => {
    installCerts([[signing.jwk]]);
    const result = await verifyAccessJwt(
      signRs256(signing, claims(NOW, { iss: "https://other.cloudflareaccess.com" })),
      access,
      NOW,
    );
    expect(result).toEqual({ ok: false, code: "issuer" });
  });

  it("rejects an expired token past the skew and a token that is not yet valid", async () => {
    installCerts([[signing.jwk]]);
    const seconds = Math.floor(NOW / 1000);
    const expired = await verifyAccessJwt(
      signRs256(signing, claims(NOW, { exp: seconds - 61, nbf: seconds - 120 })),
      access,
      NOW,
    );
    expect(expired).toEqual({ ok: false, code: "expired" });
    const early = await verifyAccessJwt(signRs256(signing, claims(NOW, { nbf: seconds + 61 })), access, NOW);
    expect(early).toEqual({ ok: false, code: "not-yet-valid" });
  });

  it("rejects alg none without fetching certificates", async () => {
    const fetchMock = installCerts([[signing.jwk]]);
    const header = Buffer.from(JSON.stringify({ alg: "none", kid: signing.kid })).toString("base64url");
    const body = Buffer.from(JSON.stringify(claims(NOW))).toString("base64url");
    const result = await verifyAccessJwt(`${header}.${body}.`, access, NOW);
    expect(result).toEqual({ ok: false, code: "algorithm" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects HS256 signed with the public key as the HMAC secret", async () => {
    const fetchMock = installCerts([[signing.jwk]]);
    const result = await verifyAccessJwt(signHs256(signing, claims(NOW)), access, NOW);
    expect(result).toEqual({ ok: false, code: "algorithm" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the previous keys when a refresh after the TTL fails", async () => {
    const fetchMock = installCerts([[signing.jwk]]);
    expect((await verifyAccessJwt(signRs256(signing, claims(NOW)), access, NOW)).ok).toBe(true);

    fetchMock.mockRejectedValue(new Error("network down"));
    const later = NOW + 61 * 60 * 1000;
    const result = await verifyAccessJwt(signRs256(signing, claims(later)), access, later);
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refetches an unknown kid once, then throttles for 60 seconds", async () => {
    const fetchMock = installCerts([[signing.jwk], [signing.jwk, rotated.jwk], [rotated.jwk]]);
    const token = signRs256(rotated, claims(NOW));
    const rotatedResult = await verifyAccessJwt(token, access, NOW);
    expect(rotatedResult).toMatchObject({ ok: true, identity: { email: "ada@example.com", sub: "user-1" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const unknown = await verifyAccessJwt(signRs256(signing, claims(NOW), "kid-c"), access, NOW + 1_000);
    expect(unknown).toEqual({ ok: false, code: "unknown-kid" });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const later = await verifyAccessJwt(signRs256(signing, claims(NOW + 61_000), "kid-c"), access, NOW + 61_000);
    expect(later).toEqual({ ok: false, code: "unknown-kid" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(loggedText()).not.toContain(token);
  });

  it("rejects an email that is not on the allowlist and logs only the email", async () => {
    installCerts([[signing.jwk]]);
    const token = signRs256(signing, claims(NOW, { email: "Bea@Other.test", groups: ["guests"] }));
    const result = await verifyAccessJwt(token, access, NOW);
    expect(result).toEqual({ ok: false, code: "not-allowed" });
    expect(vi.mocked(console.info).mock.calls.map((call) => call.join(" ")).join("\n")).toContain(
      "Cloudflare Access denied for bea@other.test",
    );
    expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
    expect(vi.mocked(console.error)).not.toHaveBeenCalled();
    expect(loggedText()).not.toContain(token);
  });

  it("allows an email by domain", async () => {
    installCerts([[signing.jwk]]);
    const result = await verifyAccessJwt(signRs256(signing, claims(NOW, { email: "Grace@Example.com" })), access, NOW);
    expect(result).toMatchObject({ ok: true, identity: { email: "grace@example.com", sub: "user-1" } });
  });

  it("allows an email by group", async () => {
    installCerts([[signing.jwk]]);
    const result = await verifyAccessJwt(
      signRs256(signing, claims(NOW, { email: "Bea@Other.test", groups: ["Readers"] })),
      access,
      NOW,
    );
    expect(identityOf(result)).toMatchObject({ email: "bea@other.test", groups: ["readers"] });
  });
});

describe("cloudflare access requests", () => {
  it("requires the assertion header and ignores the cookie and email header", async () => {
    installCerts([[signing.jwk]]);
    useAccessConfig();
    const token = signRs256(signing, claims(Date.now()));

    const missing = await app.request("/api/session");
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "authentication required" });

    const emailHeader = await app.request("/api/board", {
      headers: { "cf-access-authenticated-user-email": "ada@example.com" },
    });
    expect(emailHeader.status).toBe(401);

    const cookieOnly = await app.request("/api/session", {
      headers: {
        cookie: `CF_Authorization=${token}`,
        "cf-access-authenticated-user-email": "ada@example.com",
      },
    });
    expect(cookieOnly.status).toBe(401);

    const page = await app.request("/graph");
    expect(page.status).toBe(403);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain("Sign-in is handled by Cloudflare Access");
    expect(html).toContain('href="/cdn-cgi/access/logout"');
    expect(html).not.toContain(token);
    expect(html).not.toContain("ada@example.com");

    expect((await app.request("/healthz")).status).toBe(200);
    expect((await app.request("/readyz")).status).toBe(503);

    const allowed = await app.request("/api/session", {
      headers: {
        "cf-access-jwt-assertion": token,
        cookie: "CF_Authorization=ignored",
        "cf-access-authenticated-user-email": "bea@other.test",
      },
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ email: "ada@example.com" });
    expect(loggedText()).not.toContain(token);
  });

  it("fetches certificates when the process boots", async () => {
    const fetchMock = installCerts([[signing.jwk]]);
    bootAuth({
      SNOBOARD_AUTH_MODES: "cloudflare-access",
      SNOBOARD_CF_ACCESS_TEAM_DOMAIN: TEAM,
      SNOBOARD_CF_ACCESS_AUD: "audience-tag",
      SNOBOARD_ALLOWED_EMAILS: "ada@example.com",
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith(CERTS_URL, expect.any(Object)));
  });
});

function useAccessConfig(): void {
  setAuthConfig({ modes: ["cloudflare-access"], cloudflareAccess: access });
}

function identityOf(result: AccessJwtResult): { email: string; groups?: readonly string[] } {
  if (!result.ok) throw new Error(result.code);
  return result.identity;
}

function claims(now: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const seconds = Math.floor(now / 1000);
  return {
    aud: ["audience-tag"],
    iss: `https://${TEAM}`,
    exp: seconds + 3600,
    nbf: seconds - 30,
    email: "Ada@Example.com",
    sub: "user-1",
    ...overrides,
  };
}

function signRs256(pair: TestKey, payload: Record<string, unknown>, kid = pair.kid): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const input = `${header}.${body}`;
  const signature = createSign("RSA-SHA256").update(input).end().sign(pair.privateKey);
  return `${input}.${signature.toString("base64url")}`;
}

function signHs256(pair: TestKey, payload: Record<string, unknown>): string {
  const publicKey = createPublicKey({ key: pair.jwk, format: "jwk" });
  const pem = publicKey.export({ type: "spki", format: "pem" });
  const header = Buffer.from(JSON.stringify({ alg: "HS256", kid: pair.kid })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const input = `${header}.${body}`;
  const signature = createHmac("sha256", pem).update(input).digest("base64url");
  return `${input}.${signature}`;
}

function makeKey(kid: string): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const exported = publicKey.export({ format: "jwk" });
  if (typeof exported.n !== "string" || typeof exported.e !== "string") {
    throw new Error("expected an RSA public JWK");
  }
  return {
    kid,
    privateKey,
    jwk: { kty: "RSA", n: exported.n, e: exported.e, kid, alg: "RS256", use: "sig" },
  };
}

function installCerts(batches: JsonWebKey[][]): ReturnType<typeof vi.fn> {
  const queue = batches.map((keys) => keys);
  const fetchMock = vi.fn(async () => {
    const keys = queue.shift() ?? [];
    return new Response(JSON.stringify({ keys }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function loggedText(): string {
  const methods = ["info", "warn", "error", "log"] as const;
  return methods
    .flatMap((method) => vi.mocked(console[method]).mock.calls)
    .map((call) => call.map(String).join(" "))
    .join("\n");
}
