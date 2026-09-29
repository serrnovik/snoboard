import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Config, Snapshot } from "snoboard";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetAuthConfig, setAuthConfig } from "./env.js";
import { app } from "../index.js";
import { resetStore, seedStore } from "../store.js";
import { resetRefreshLimits } from "../api.js";
import {
  beginPasswordAttempt,
  hashPassword,
  PASSWORD_ATTEMPT_WINDOW_MS,
  PASSWORD_GLOBAL_ATTEMPT_LIMIT,
  passwordMatches,
  resetPasswordAttempts,
} from "./password.js";
import { readCookie, SESSION_COOKIE, verifySession } from "./session.js";

const CORRECT = "correct-password";
const secret = randomBytes(32);
let passwordHash = "";

beforeAll(async () => {
  passwordHash = await hashPassword(CORRECT);
});

describe("password login", () => {
  beforeEach(() => {
    resetPasswordAttempts();
    resetRefreshLimits();
    resetStore();
    setAuthConfig({
      modes: ["password"],
      publicUrl: "http://localhost:3000",
      sessionSecret: secret,
      passwordHash,
    });
  });

  afterEach(() => {
    resetPasswordAttempts();
    resetRefreshLimits();
    resetStore();
    resetAuthConfig();
  });

  it("sets a session cookie for the right password and rejects the wrong one", async () => {
    const wrong = await postPassword("nope", "203.0.113.10");
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "invalid password" });
    expect(wrong.headers.get("set-cookie")).toBeNull();

    const right = await postPassword(CORRECT, "203.0.113.11");
    expect(right.status).toBe(200);
    expect(await right.json()).toEqual({ ok: true });
    const setCookie = right.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Max-Age=2592000");
    expect(setCookie).not.toMatch(/(?:^|;\s*)Secure(?:;|$)/);

    const token = readCookie(setCookie.split(";")[0], SESSION_COOKIE);
    expect(token).toBeTruthy();
    const claims = verifySession(secret, token ?? "", Date.now());
    expect(claims?.sub).toBe("password");
    expect(claims?.method).toBe("password");

    seedReady();
    const board = await app.request("/api/board", { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    expect(board.status).toBe(200);

    setAuthConfig({
      modes: ["password"],
      publicUrl: "https://board.example",
      sessionSecret: secret,
      passwordHash,
    });
    const secure = await postPassword(CORRECT, "203.0.113.12");
    expect(secure.headers.get("set-cookie")).toMatch(/(?:^|;\s*)Secure(?:;|$)/);
  });

  it("returns 429 on the sixth wrong attempt from the same address", async () => {
    const ip = "203.0.113.20";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await postPassword(`wrong-${attempt}`, ip);
      expect(response.status).toBe(401);
    }
    const limited = await postPassword(CORRECT, ip);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "too many attempts" });
    expect(limited.headers.get("retry-after")).toBeTruthy();

    const other = await postPassword("still-wrong", "203.0.113.21");
    expect(other.status).toBe(401);

    const start = 1_700_000_000_000;
    const windowIp = "203.0.113.22";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(beginPasswordAttempt(windowIp, start)).toBe("ok");
    }
    expect(beginPasswordAttempt(windowIp, start + 1_000)).toBe("limited");
    expect(beginPasswordAttempt(windowIp, start + PASSWORD_ATTEMPT_WINDOW_MS)).toBe("ok");
  });

  it("caps failed attempts globally even when the client address changes", async () => {
    const start = 1_700_000_000_000;
    for (let attempt = 0; attempt < PASSWORD_GLOBAL_ATTEMPT_LIMIT; attempt += 1) {
      expect(beginPasswordAttempt(`198.51.100.${attempt}`, start)).toBe("ok");
    }
    expect(beginPasswordAttempt("198.51.100.250", start + 1_000)).toBe("limited");
  });

  it("logs out by clearing the session cookie", async () => {
    const response = await app.request("/auth/logout", {
      method: "POST",
      headers: { origin: "http://localhost:3000" },
    });
    expect(response.status).toBe(200);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE}=;`);
    expect(setCookie).toContain("Max-Age=0");
  });

  it("checks a form post and the hash script", async () => {
    const form = await app.request("/auth/password", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "http://localhost:3000",
        "x-forwarded-for": "203.0.113.30",
      },
      body: new URLSearchParams({ password: CORRECT }),
    });
    expect(form.status).toBe(302);
    expect(form.headers.get("location")).toBe("/");
    expect(form.headers.get("set-cookie")).toContain("snoboard_session=");

    expect(await passwordMatches(passwordHash, CORRECT)).toBe(true);
    expect(await passwordMatches(passwordHash, "nope")).toBe(false);
    expect(await passwordMatches("$argon2id$not-a-hash", CORRECT)).toBe(false);

    const script = fileURLToPath(new URL("../../scripts/hash-password.mjs", import.meta.url));
    const missing = spawnSync(process.execPath, [script], { encoding: "utf8" });
    expect(missing.status).toBe(1);
    const hashed = spawnSync(process.execPath, [script, "example-password"], { encoding: "utf8" });
    expect(hashed.status).toBe(0);
    const printed = hashed.stdout.trim();
    expect(printed.startsWith("$argon2id$")).toBe(true);
    expect(await passwordMatches(printed, "example-password")).toBe(true);
    expect(hashed.stdout).not.toContain("example-password");
  });
});

function postPassword(password: string, ip: string): Promise<Response> {
  return app.request("/auth/password", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": ip,
    },
    body: JSON.stringify({ password }),
  });
}

function seedReady(): void {
  const snapshot = {
    generatedAt: "2026-01-01T00:00:00.000Z",
    refs: [],
    items: [],
    legacy: [],
    errors: [],
    graph: { nodes: new Map(), edges: [], doneStatuses: ["done"] },
  } as Snapshot;
  const config = {
    root: "initiatives",
    file: "initiative.md",
    idFormat: "{project}-{number}",
    defaultBranch: "main",
    branchPatterns: ["initiative/*"],
    statuses: ["planned", "done"],
    doneStatuses: ["done"],
    priorities: ["p1"],
    staleAfterDays: 30,
  } satisfies Config;
  seedStore(snapshot, config);
}
