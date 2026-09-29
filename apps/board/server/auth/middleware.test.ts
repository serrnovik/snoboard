import { randomBytes } from "node:crypto";
import type { Config, Snapshot } from "snoboard";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetRefreshLimits } from "../api.js";
import { app } from "../index.js";
import { resetStore, seedStore } from "../store.js";
import { loadAuthConfig, resetAuthConfig, setAuthConfig } from "./env.js";
import { SESSION_COOKIE, signSession } from "./session.js";

const secret = randomBytes(32);

describe("auth middleware", () => {
  beforeEach(() => {
    resetStore();
    resetRefreshLimits();
    setAuthConfig({
      modes: ["password"],
      publicUrl: "https://board.example",
      sessionSecret: secret,
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$aaaaaaaaaaaaaaaa$bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
  });

  afterEach(() => {
    resetStore();
    resetRefreshLimits();
    resetAuthConfig();
  });

  it("requires a session for the API and pages, and leaves public routes open", async () => {
    const board = await app.request("/api/board");
    expect(board.status).toBe(401);
    expect(await board.json()).toEqual({ error: "authentication required" });
    expect(board.headers.get("cache-control")).toBe("no-store");

    const home = await app.request("/");
    expect(home.status).toBe(302);
    expect(locationPath(home)).toBe("/login");

    const graph = await app.request("/graph");
    expect(graph.status).toBe(302);
    expect(locationPath(graph)).toBe("/login");

    expect((await app.request("/healthz")).status).toBe(200);
    expect((await app.request("/readyz")).status).toBe(503);
    expect((await app.request("/login")).status).toBe(404);
    expect((await app.request("/assets/app.js")).status).toBe(404);

    const issued = cookieFor("reader");
    const token = issued.slice(SESSION_COOKIE.length + 1);
    // Flip a character inside the signature (the last char may only carry padding bits).
    const at = token.length - 5;
    const flipped = `${token.slice(0, at)}${token[at] === "a" ? "b" : "a"}${token.slice(at + 1)}`;
    const tampered = await app.request("/api/board", {
      headers: { cookie: `${SESSION_COOKIE}=${flipped}` },
    });
    expect(tampered.status).toBe(401);

    const expired = signSession(secret, {
      sub: "reader",
      method: "password",
      iat: Date.now() - 10_000,
      exp: Date.now() - 1,
    });
    const stale = await app.request("/api/board", { headers: { cookie: `${SESSION_COOKIE}=${expired}` } });
    expect(stale.status).toBe(401);

    seedReady();
    const allowed = await app.request("/api/board", { headers: { cookie: cookieFor("reader") } });
    expect(allowed.status).toBe(200);
  });

  it("rejects a cross-origin refresh and keeps the rate limit on the session subject", async () => {
    const cross = await app.request("/api/refresh", {
      method: "POST",
      headers: {
        cookie: cookieFor("reader", Date.now() - 10_000),
        origin: "https://evil.example",
      },
    });
    expect(cross.status).toBe(403);
    expect(await cross.json()).toEqual({ error: "cross-origin request rejected" });

    const referred = await app.request("/api/refresh", {
      method: "POST",
      headers: {
        cookie: cookieFor("reader", Date.now() - 9_000),
        referer: "https://evil.example/phish",
      },
    });
    expect(referred.status).toBe(403);

    const same = await app.request("/api/refresh", {
      method: "POST",
      headers: {
        cookie: cookieFor("reader", Date.now() - 8_000),
        origin: "https://board.example",
      },
    });
    expect(same.status).toBe(202);

    const again = await app.request("/api/refresh", {
      method: "POST",
      headers: {
        cookie: cookieFor("reader", Date.now() - 7_000),
        origin: "https://board.example",
      },
    });
    expect(again.status).toBe(429);

    const other = await app.request("/api/refresh", {
      method: "POST",
      headers: {
        cookie: cookieFor("other", Date.now() - 7_000),
        origin: "https://board.example",
      },
    });
    expect(other.status).toBe(202);
  });

  it("allows none mode only when startup accepted AUTH_ALLOW_NONE", async () => {
    setAuthConfig(loadAuthConfig({ SNOBOARD_AUTH_MODES: "none", SNOBOARD_AUTH_ALLOW_NONE: "true" }));
    const open = await app.request("/api/board");
    expect(open.status).toBe(503);

    const home = await app.request("/");
    expect(home.status).not.toBe(302);

    // Browser POSTs carry Origin; without SNOBOARD_PUBLIC_URL, same-host is allowed.
    const sameHost = await app.request("http://localhost:3000/api/refresh", {
      method: "POST",
      headers: { host: "localhost:3000", origin: "http://localhost:3000" },
    });
    expect(sameHost.status).not.toBe(403);
    const crossSite = await app.request("http://localhost:3000/api/refresh", {
      method: "POST",
      headers: { host: "localhost:3000", origin: "https://evil.example" },
    });
    expect(crossSite.status).toBe(403);
  });

  it("caps request bodies even without Content-Length", async () => {
    const big = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`{"password":"${"x".repeat(64 * 1024)}"}`));
        controller.close();
      },
    });
    const response = await app.request("/auth/password", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://board.example" },
      body: big,
      // @ts-expect-error Node's fetch requires duplex for streamed bodies.
      duplex: "half",
    });
    expect(response.status).toBe(413);
  });
});

function cookieFor(sub: string, iat = Date.now()): string {
  const token = signSession(secret, {
    sub,
    method: "password",
    iat,
    exp: iat + 60 * 60 * 1000,
  });
  return `${SESSION_COOKIE}=${token}`;
}

function locationPath(response: Response): string {
  const location = response.headers.get("location") ?? "";
  if (location.startsWith("/")) return location.split("?")[0] ?? location;
  return new URL(location, "https://board.example").pathname;
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
