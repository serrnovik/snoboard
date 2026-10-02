import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../index.js";
import { resetEditConfig, setEditConfig } from "../edit-env.js";
import { resetActiveRepos, setActiveRepos } from "../repos-config.js";
import { resetAuthConfig, setAuthConfig, type GithubAuthConfig } from "./env.js";
import {
  OAUTH_COOKIE,
  openOAuthPending,
  resetGithubLimits,
  safeReturnPath,
  sealOAuthPending,
  setGithubLogger,
} from "./github.js";
import type { BoardEnv } from "./middleware.js";
import { readCookie, SESSION_COOKIE, signSession, type SessionClaims } from "./session.js";
import {
  getWriteToken,
  resetWriteTokens,
  sessionKeyOf,
  storedWriteTokenBytes,
  storeWriteToken,
  WRITE_COOKIE,
  WRITE_TOKEN_TTL_MS,
  writeTokenCount,
} from "./write-tokens.js";

const WRITE_TOKEN = "synthetic-write-token-0123456789";
const CLIENT_SECRET = "synthetic-client-secret";
const secret = randomBytes(32);
const logs: string[] = [];

describe("GitHub write grant", () => {
  beforeEach(() => {
    logs.length = 0;
    resetGithubLimits();
    resetWriteTokens();
    setGithubLogger({ info: (message) => logs.push(message) });
    vi.spyOn(console, "info").mockImplementation((...args) => void logs.push(args.map(String).join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args) => void logs.push(args.map(String).join(" ")));
    useGithub();
    setEditConfig({ enabled: true, modes: ["pr"], botTokenConfigured: false });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setGithubLogger();
    resetAuthConfig();
    resetEditConfig();
    resetActiveRepos();
    resetWriteTokens();
  });

  it("never asks for a write scope at login", async () => {
    const response = await app.request("/auth/github");
    const scope = new URL(response.headers.get("location") ?? "").searchParams.get("scope") ?? "";
    expect(scope).toBe("read:user");
    expect(scope).not.toContain("repo");
    const pending = pendingFrom(response);
    expect(pending?.purpose).toBe("login");
  });

  it("starts the write flow on the same callback with the repo scope (or public_repo)", async () => {
    const session = githubSession("octocat");
    const response = await app.request("/auth/github/write?return=/?initiative=acme-001", {
      headers: { cookie: sessionHeader(session) },
    });
    expect(response.status).toBe(302);
    const authorize = new URL(response.headers.get("location") ?? "");
    expect(authorize.searchParams.get("redirect_uri")).toBe("https://board.example/auth/github/callback");
    expect(authorize.searchParams.get("scope")).toBe("repo");
    const pending = pendingFrom(response);
    expect(pending).toMatchObject({ purpose: "write", returnTo: "/?initiative=acme-001", sessionKey: sessionKeyOf(session) });

    useGithub({ writeScope: "public_repo" });
    const publicOnly = await app.request("/auth/github/write", { headers: { cookie: sessionHeader(session) } });
    expect(new URL(publicOnly.headers.get("location") ?? "").searchParams.get("scope")).toBe("public_repo");
  });

  it("asks for the target repo's scope and refuses repos without editing", async () => {
    setActiveRepos([
      { id: "site", name: "Site", url: "https://example.com/site.git", edit: { modes: ["pr"], githubWriteScope: "public_repo" } },
      { id: "core", name: "Core", url: "https://example.com/core.git", edit: { modes: ["direct"], directBranch: "main" } },
      { id: "docs", name: "Docs", url: "https://example.com/docs.git", edit: { modes: [] } },
    ]);
    const session = githubSession("octocat");
    const headers = { cookie: sessionHeader(session) };
    const site = await app.request("/auth/github/write?repo=site&return=/r/site/", { headers });
    expect(new URL(site.headers.get("location") ?? "").searchParams.get("scope")).toBe("public_repo");
    expect(pendingFrom(site)).toMatchObject({ purpose: "write", scope: "public_repo", returnTo: "/r/site/" });

    const core = await app.request("/auth/github/write?repo=core", { headers });
    expect(new URL(core.headers.get("location") ?? "").searchParams.get("scope")).toBe("repo");

    // No repo given: the first catalog entry.
    const first = await app.request("/auth/github/write", { headers });
    expect(new URL(first.headers.get("location") ?? "").searchParams.get("scope")).toBe("public_repo");

    expect((await app.request("/auth/github/write?repo=docs", { headers })).status).toBe(404);
    expect((await app.request("/auth/github/write?repo=unknown", { headers })).status).toBe(404);
    expect((await app.request("/auth/github/write?repo=../x", { headers })).status).toBe(404);
  });

  it("checks the granted scope against the scope the repo asked for", async () => {
    setActiveRepos([
      { id: "core", name: "Core", url: "https://example.com/core.git", edit: { modes: ["pr"], githubWriteScope: "repo" } },
    ]);
    useGithub({ writeScope: "public_repo" });
    const session = githubSession("octocat");
    const started = await startWrite(session);
    installFetch({ login: "octocat", scope: "public_repo" });
    const response = await finish(started, session);
    expect(response.status).toBe(403);
    expect(writeTokenCount()).toBe(0);
  });

  it("offers the write flow only to GitHub sessions with editing on and github mode configured", async () => {
    const anonymous = await app.request("/auth/github/write");
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.get("location")).toBe("/login");

    const password = await app.request("/auth/github/write", {
      headers: { cookie: sessionHeader({ ...githubSession("octocat"), method: "password" }) },
    });
    expect(password.headers.get("location")).toBe("/login");

    resetEditConfig();
    const disabled = await app.request("/auth/github/write", { headers: { cookie: sessionHeader(githubSession("octocat")) } });
    expect(disabled.status).toBe(404);

    setEditConfig({ enabled: true, modes: ["pr"], botTokenConfigured: true });
    setAuthConfig({ modes: ["password"], publicUrl: "https://board.example", sessionSecret: secret, passwordHash: "x" });
    const passwordMode = await app.request("/auth/github/write", { headers: { cookie: sessionHeader(githubSession("octocat")) } });
    expect(passwordMode.status).toBe(404);
  });

  it.each([
    ["//evil.example/x", "/"],
    ["https://evil.example/", "/"],
    ["/\\evil.example", "/"],
    ["javascript:alert(1)", "/"],
    ["/auth/github/write", "/"],
    ["/%0d%0aSet-Cookie:x", "/%0d%0aSet-Cookie:x"],
    ["/ space", "/"],
    ["/?initiative=acme-001#body", "/?initiative=acme-001#body"],
  ])("only returns to same-origin paths (%s)", (raw, expected) => {
    expect(safeReturnPath(raw, "https://board.example")).toBe(expected);
  });

  it("stores the token encrypted, sets only a handle cookie, and never mints a session", async () => {
    const session = githubSession("OctoCat");
    const started = await startWrite(session, "/?initiative=acme-001");
    installFetch({ login: "octocat", scope: "repo" });
    const callback = await finish(started, session);
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/?initiative=acme-001");
    const cookies = callback.headers.getSetCookie();
    const handleCookie = cookies.find((cookie) => cookie.startsWith(`${WRITE_COOKIE}=`)) ?? "";
    expect(handleCookie).toContain("Path=/api");
    expect(handleCookie).toContain("HttpOnly");
    expect(handleCookie).toContain("SameSite=Lax");
    expect(handleCookie).toMatch(/(?:^|;\s*)Secure(?:;|$)/);
    expect(handleCookie).toMatch(/Max-Age=(\d+)/);
    expect(Number(/Max-Age=(\d+)/.exec(handleCookie)?.[1])).toBeLessThanOrEqual(3600);
    expect(cookies.some((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`))).toBe(false);
    expect(cookies.join("\n")).not.toContain(WRITE_TOKEN);
    expect(await callback.text()).not.toContain(WRITE_TOKEN);
    expect(writeTokenCount()).toBe(1);
    for (const bytes of storedWriteTokenBytes()) {
      expect(bytes.toString("utf8")).not.toContain(WRITE_TOKEN);
      expect(bytes.toString("base64")).not.toContain(Buffer.from(WRITE_TOKEN).toString("base64"));
    }
    expect(logs.join("\n")).not.toContain(WRITE_TOKEN);

    const handle = readCookie(handleCookie.split(";")[0], WRITE_COOKIE) ?? "";
    const probe = await probeToken(session, handle);
    expect(probe).toEqual({ login: "OctoCat", matches: true });
  });

  it("rejects a write callback whose GitHub login differs from the session", async () => {
    const session = githubSession("octocat");
    const started = await startWrite(session);
    installFetch({ login: "someone-else", scope: "repo" });
    const response = await finish(started, session);
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("different account");
    expect(writeTokenCount()).toBe(0);
    expect(response.headers.getSetCookie().join("\n")).not.toContain(WRITE_COOKIE);
    expect(logs.join("\n")).not.toContain(WRITE_TOKEN);
  });

  it("rejects a grant without the write scope", async () => {
    const session = githubSession("octocat");
    const started = await startWrite(session);
    installFetch({ login: "octocat", scope: "read:user" });
    const response = await finish(started, session);
    expect(response.status).toBe(403);
    expect(writeTokenCount()).toBe(0);
  });

  it("keeps login and write purposes apart", async () => {
    // A login state completes as a login: a session, never a write token.
    const login = await app.request("/auth/github");
    const loginCookie = oauthCookieOf(login);
    const loginState = openOAuthPending(secret, loginCookie, Date.now())?.state ?? "";
    installFetch({ login: "octocat", scope: "read:user" });
    const asLogin = await app.request(`/auth/github/callback?code=c&state=${loginState}`, {
      headers: { cookie: `${OAUTH_COOKIE}=${loginCookie}; ${sessionHeader(githubSession("octocat"))}` },
    });
    expect(asLogin.status).toBe(302);
    expect(asLogin.headers.getSetCookie().some((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`))).toBe(true);
    expect(asLogin.headers.getSetCookie().some((cookie) => cookie.startsWith(`${WRITE_COOKIE}=`))).toBe(false);
    expect(writeTokenCount()).toBe(0);

    // A write state without its session is rejected before GitHub is called, and signs nobody in.
    const session = githubSession("octocat");
    const started = await startWrite(session);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const noSession = await app.request(`/auth/github/callback?code=c&state=${started.state}`, {
      headers: { cookie: `${OAUTH_COOKIE}=${started.cookie}` },
    });
    expect(noSession.status).toBe(403);
    expect(noSession.headers.getSetCookie().some((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`))).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();

    // A write state presented with another session is rejected too.
    const other = await startWrite(session);
    const otherSession = githubSession("octocat", Date.now() - 1000);
    const swapped = await finish(other, otherSession);
    expect(swapped.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();

    // A sealed write purpose without a session binding does not open.
    const forged = sealOAuthPending(secret, {
      state: "s".repeat(43),
      verifier: "v".repeat(43),
      exp: Date.now() + 60_000,
      purpose: "write",
      returnTo: "/",
    });
    expect(openOAuthPending(secret, forged, Date.now())).toBeNull();
    // An old-format cookie without a purpose does not open.
    const legacy = sealOAuthPending(secret, {
      state: "s".repeat(43),
      verifier: "v".repeat(43),
      exp: Date.now() + 60_000,
      purpose: undefined as unknown as "login",
    });
    expect(openOAuthPending(secret, legacy, Date.now())).toBeNull();
  });

  it("rejects a write callback with a mismatched state", async () => {
    const session = githubSession("octocat");
    const started = await startWrite(session);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await app.request(`/auth/github/callback?code=c&state=${"x".repeat(43)}`, {
      headers: { cookie: `${OAUTH_COOKIE}=${started.cookie}; ${sessionHeader(session)}` },
    });
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(writeTokenCount()).toBe(0);
  });

  it("ignores a tampered handle, another session's handle, and expired tokens", async () => {
    const session = githubSession("octocat");
    const now = Date.now();
    const { handle } = storeWriteToken(secret, session, WRITE_TOKEN, now);
    expect(await probeToken(session, handle)).toEqual({ login: "octocat", matches: true });

    const flipped = `${handle.slice(0, -1)}${handle.endsWith("A") ? "B" : "A"}`;
    expect(await probeToken(session, flipped)).toEqual({ login: null, matches: false });

    const other = githubSession("octocat", now - 5000);
    expect(await probeToken(other, handle)).toEqual({ login: null, matches: false });
    const otherLogin = { ...session, sub: "hubot" };
    expect(await probeToken(otherLogin, handle)).toEqual({ login: null, matches: false });

    expect(await probeToken(session, handle, now + WRITE_TOKEN_TTL_MS - 1)).toMatchObject({ matches: true });
    expect(await probeToken(session, handle, now + WRITE_TOKEN_TTL_MS + 1)).toEqual({ login: null, matches: false });
    expect(writeTokenCount()).toBe(0);
  });

  it("stops asking to connect once a write token is stored", async () => {
    const session = githubSession("octocat");
    const before = await app.request("/api/edit-config", { headers: { cookie: sessionHeader(session) } });
    expect(await before.json()).toMatchObject({ canSubmit: true, needsGithubWrite: true });
    const { handle } = storeWriteToken(secret, session, WRITE_TOKEN);
    const after = await app.request("/api/edit-config", {
      headers: { cookie: `${sessionHeader(session)}; ${WRITE_COOKIE}=${handle}` },
    });
    expect(await after.json()).toMatchObject({ canSubmit: true, needsGithubWrite: false });
  });

  it("keeps one token per session and never outlives the session", () => {
    const now = Date.now();
    const session = { ...githubSession("octocat"), exp: now + 10 * 60 * 1000 };
    const first = storeWriteToken(secret, session, WRITE_TOKEN, now);
    const second = storeWriteToken(secret, session, `${WRITE_TOKEN}-2`, now);
    expect(writeTokenCount()).toBe(1);
    expect(first.handle).not.toBe(second.handle);
    expect(second.maxAgeSeconds).toBeLessThanOrEqual(600);
  });

  it("clears the token on DELETE /auth/github/write and on logout", async () => {
    const session = githubSession("octocat");
    const { handle } = storeWriteToken(secret, session, WRITE_TOKEN);
    const cookie = `${sessionHeader(session)}; ${WRITE_COOKIE}=${handle}`;
    const cleared = await app.request("/auth/github/write", {
      method: "DELETE",
      headers: { cookie, origin: "https://board.example" },
    });
    expect(cleared.status).toBe(204);
    expect(writeTokenCount()).toBe(0);
    const expired = cleared.headers.getSetCookie().find((value) => value.startsWith(`${WRITE_COOKIE}=`)) ?? "";
    expect(expired).toContain("Max-Age=0");
    expect(expired).toContain("Path=/api");

    const crossSite = await app.request("/auth/github/write", {
      method: "DELETE",
      headers: { cookie, origin: "https://evil.example" },
    });
    expect(crossSite.status).toBe(403);

    setAuthConfig({
      modes: ["github", "password"],
      publicUrl: "https://board.example",
      sessionSecret: secret,
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$aaaaaaaaaaaaaaaa$bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      github: githubConfig(),
    });
    storeWriteToken(secret, session, WRITE_TOKEN);
    const logout = await app.request("/auth/logout", {
      method: "POST",
      headers: { cookie: sessionHeader(session), origin: "https://board.example" },
    });
    expect(logout.status).toBe(200);
    expect(writeTokenCount()).toBe(0);
    expect(logout.headers.getSetCookie().some((value) => value.startsWith(`${SESSION_COOKIE}=;`))).toBe(true);
  });
});

function githubConfig(extra: Partial<GithubAuthConfig> = {}): GithubAuthConfig {
  return {
    clientId: "client-id",
    clientSecret: CLIENT_SECRET,
    allowedLogins: ["octocat"],
    allowedOrgs: [],
    ...extra,
  };
}

function useGithub(extra: Partial<GithubAuthConfig> = {}): void {
  setAuthConfig({
    modes: ["github"],
    publicUrl: "https://board.example",
    sessionSecret: secret,
    github: githubConfig(extra),
  });
}

function githubSession(sub: string, iat = Date.now()): SessionClaims {
  return { sub, method: "github", iat, exp: iat + 24 * 60 * 60 * 1000 };
}

function sessionHeader(claims: SessionClaims): string {
  return `${SESSION_COOKIE}=${signSession(secret, claims)}`;
}

function oauthCookieOf(response: Response): string {
  const header = response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${OAUTH_COOKIE}=`)) ?? "";
  return readCookie(header.split(";")[0], OAUTH_COOKIE) ?? "";
}

function pendingFrom(response: Response): ReturnType<typeof openOAuthPending> {
  return openOAuthPending(secret, oauthCookieOf(response), Date.now());
}

async function startWrite(session: SessionClaims, returnTo = "/"): Promise<{ cookie: string; state: string }> {
  const response = await app.request(`/auth/github/write?return=${encodeURIComponent(returnTo)}`, {
    headers: { cookie: sessionHeader(session) },
  });
  expect(response.status).toBe(302);
  const cookie = oauthCookieOf(response);
  const pending = openOAuthPending(secret, cookie, Date.now());
  expect(pending?.purpose).toBe("write");
  return { cookie, state: pending?.state ?? "" };
}

function finish(started: { cookie: string; state: string }, session: SessionClaims): Promise<Response> {
  return app.request(`/auth/github/callback?code=auth-code&state=${started.state}`, {
    headers: { cookie: `${OAUTH_COOKIE}=${started.cookie}; ${sessionHeader(session)}` },
  });
}

function installFetch(options: { login: string; scope: string }): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://github.com/login/oauth/access_token") {
        return Response.json({ access_token: WRITE_TOKEN, token_type: "bearer", scope: options.scope });
      }
      if (url === "https://api.github.com/user") return Response.json({ login: options.login });
      return new Response("missing", { status: 404 });
    }),
  );
}

/** Runs getWriteToken inside a request, as the API does. */
async function probeToken(
  session: SessionClaims,
  handle: string,
  now = Date.now(),
): Promise<{ login: string | null; matches: boolean }> {
  const probe = new Hono<BoardEnv>();
  probe.get("/api/probe", (c) => {
    c.set("session", session);
    const found = getWriteToken(c, now);
    return c.json({ login: found?.login ?? null, matches: found?.token.startsWith(WRITE_TOKEN) ?? false });
  });
  const response = await probe.request("/api/probe", {
    headers: { cookie: `${sessionHeader(session)}; ${WRITE_COOKIE}=${handle}` },
  });
  const body = (await response.json()) as { login: string | null; matches: boolean };
  expect(JSON.stringify(body)).not.toContain(WRITE_TOKEN);
  return body;
}
