import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  openEncoded,
  serializeCookie,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  signEncoded,
  signSession,
  usesSecureCookie,
  verifySession,
} from "./session.js";

const now = 1_800_000_000_000;

function claims(exp = now + 60_000) {
  return { sub: "password", method: "password" as const, iat: now, exp };
}

describe("session cookies", () => {
  it("verifies a signed session and rejects tampering, expiry, and a rotated secret", () => {
    const secret = randomBytes(32);
    const token = signSession(secret, claims());
    expect(verifySession(secret, token, now)).toEqual(claims());

    const [payload, signature] = token.split(".");
    expect(payload).toBeTruthy();
    expect(signature).toBeTruthy();
    const flipped = `${payload}.${signature?.[0] === "A" ? "B" : "A"}${signature?.slice(1)}`;
    expect(verifySession(secret, flipped, now)).toBeNull();

    const replaced = Buffer.from(
      JSON.stringify({ ...claims(), sub: "other" }),
    ).toString("base64url");
    expect(verifySession(secret, `${replaced}.${signature}`, now)).toBeNull();

    const expired = signSession(secret, {
      sub: "password",
      method: "password",
      iat: now - 10_000,
      exp: now - 1,
    });
    expect(verifySession(secret, expired, now)).toBeNull();

    const rotated = randomBytes(32);
    expect(verifySession(rotated, token, now)).toBeNull();
    expect(verifySession(secret, token, now)?.sub).toBe("password");
  });

  it("drops unexpected claims and rejects a session longer than 30 days", () => {
    const secret = randomBytes(32);
    const encoded = Buffer.from(
      JSON.stringify({ ...claims(), access: "synthetic-access-token", role: "admin" }),
    ).toString("base64url");
    const token = signEncoded(secret, encoded);
    expect(verifySession(secret, token, now)).toEqual(claims());
    expect(JSON.stringify(verifySession(secret, token, now))).not.toContain("synthetic-access-token");

    const tooLong = signSession(secret, claims(now + SESSION_TTL_MS + 1));
    expect(verifySession(secret, tooLong, now)).toBeNull();

    const forged = Buffer.from(
      JSON.stringify({ sub: "password", method: "none", iat: now, exp: now + 60_000 }),
    ).toString("base64url");
    expect(verifySession(secret, signEncoded(secret, forged), now)).toBeNull();
    expect(openEncoded(secret, token)).toBe(encoded);
    expect(createHmac("sha256", secret).update(encoded).digest("base64url")).toBe(token.split(".")[1]);
  });

  it("sets Secure only when the public URL is not http://localhost", () => {
    expect(usesSecureCookie("http://localhost")).toBe(false);
    expect(usesSecureCookie("http://localhost:3000")).toBe(false);
    expect(usesSecureCookie("https://localhost")).toBe(true);
    expect(usesSecureCookie("https://board.example")).toBe(true);
    expect(usesSecureCookie(undefined)).toBe(true);

    const local = serializeCookie(SESSION_COOKIE, "token", { maxAge: 2592000, path: "/", secure: false });
    expect(local).toContain("HttpOnly");
    expect(local).toContain("SameSite=Lax");
    expect(local).toContain("Max-Age=2592000");
    expect(local).toContain("Path=/");
    expect(local).not.toMatch(/(?:^|;\s*)Secure(?:;|$)/);

    const remote = serializeCookie(SESSION_COOKIE, "token", { maxAge: 2592000, path: "/", secure: true });
    expect(remote).toMatch(/(?:^|;\s*)Secure(?:;|$)/);
  });
});

describe("signature encoding", () => {
  it("rejects a non-canonical base64url signature", async () => {
    const { randomBytes } = await import("node:crypto");
    const { signSession, verifySession } = await import("./session.js");
    const key = randomBytes(32);
    const now = Date.now();
    const token = signSession(key, { sub: "reader", method: "password", iat: now, exp: now + 60_000 });
    const last = token.at(-1) ?? "A";
    // 32 bytes -> 43 chars; the last char holds 2 data bits. Keep them, change the padding bits.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const index = alphabet.indexOf(last);
    const variant = alphabet[(index & 0b110000) | ((index + 1) & 0b001111)] ?? last;
    const altered = `${token.slice(0, -1)}${variant}`;
    expect(verifySession(key, token, now)).not.toBeNull();
    expect(verifySession(key, altered, now)).toBeNull();
  });
});
