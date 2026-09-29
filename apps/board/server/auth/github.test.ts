import { createHash, randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../index.js";
import { resetAuthConfig, setAuthConfig, type GithubAuthConfig } from "./env.js";
import {
  callbackAllowed,
  GITHUB_CALLBACK_LIMIT,
  OAUTH_COOKIE,
  openOAuthPending,
  resetGithubLimits,
  setGithubLogger,
} from "./github.js";
import { readCookie, SESSION_COOKIE, verifySession } from "./session.js";

const ACCESS_TOKEN = "synthetic-access-token";
const CLIENT_SECRET = "synthetic-client-secret";
const secret = randomBytes(32);

type FetchCall = {
  url: string;
  body: string;
  authorization: string;
};

describe("GitHub login", () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});

  beforeEach(() => {
    info.mockClear();
    resetGithubLimits();
    setGithubAuth({ allowedLogins: ["octocat"], allowedOrgs: ["acme"] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setGithubLogger();
    resetAuthConfig();
  });

  afterAll(() => {
    info.mockRestore();
  });

  it("sends PKCE state and accepts an allowlisted login without storing the access token", async () => {
    const started = await start();
    expect(started.authorize.origin).toBe("https://github.com");
    expect(started.authorize.pathname).toBe("/login/oauth/authorize");
    expect(started.authorize.searchParams.get("client_id")).toBe("client-id");
    expect(started.authorize.searchParams.get("redirect_uri")).toBe(
      "https://board.example/auth/github/callback",
    );
    expect(started.authorize.searchParams.get("scope")).toBe("read:user read:org");
    expect(started.authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(started.authorize.searchParams.get("state")).toBe(started.pending.state);
    expect(started.authorize.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(started.pending.verifier).digest("base64url"),
    );
    expect(started.authorize.toString()).not.toContain(CLIENT_SECRET);
    expect(started.oauthCookie).toContain("HttpOnly");
    expect(started.oauthCookie).toContain("SameSite=Lax");
    expect(started.oauthCookie).toContain("Max-Age=600");
    expect(started.oauthCookie).toContain("Path=/auth/github");
    expect(started.oauthCookie).toMatch(/(?:^|;\s*)Secure(?:;|$)/);

    const calls = installFetch({ login: "OctoCat", userStatus: 200, orgStatus: 500 });
    const callback = await finish(started, started.pending.state);
    expect(callback.status).toBe(302);
    expect(locationPath(callback)).toBe("/");
    expect(calls.map((call) => call.url)).toEqual([
      "https://github.com/login/oauth/access_token",
      "https://api.github.com/user",
    ]);
    expect(calls[0]?.body).toContain(`code_verifier=${started.pending.verifier}`);
    expect(calls[0]?.body).toContain(`client_secret=${CLIENT_SECRET}`);
    expect(calls[1]?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);

    const session = sessionCookie(callback);
    expect(session).toBeTruthy();
    const claims = verifySession(secret, session ?? "", Date.now());
    expect(claims).toMatchObject({ sub: "OctoCat", method: "github" });
    expect(JSON.stringify(claims)).not.toContain(ACCESS_TOKEN);
    expect(callback.headers.getSetCookie().join("\n")).not.toContain(ACCESS_TOKEN);
    expect(loggedText()).not.toContain(ACCESS_TOKEN);
    expect(loggedText()).not.toContain(CLIENT_SECRET);
    const cleared = callback.headers.getSetCookie().find((cookie) => cookie.startsWith(`${OAUTH_COOKIE}=`));
    expect(cleared).toContain("Max-Age=0");
  });

  it("rejects a replayed callback cookie without calling GitHub again", async () => {
    const started = await start();
    const calls = installFetch({ login: "octocat", userStatus: 200, orgStatus: 500 });
    const first = await finish(started, started.pending.state);
    expect(first.status).toBe(302);
    const callsAfterFirst = calls.length;

    const replay = await finish(started, started.pending.state);
    expect(replay.status).toBe(400);
    expect(calls.length).toBe(callsAfterFirst);
  });

  it("caps GitHub callbacks globally", () => {
    const now = 1_700_000_000_000;
    for (let index = 0; index < GITHUB_CALLBACK_LIMIT; index += 1) {
      expect(callbackAllowed(now)).toBe(true);
    }
    expect(callbackAllowed(now + 1_000)).toBe(false);
  });

  it("rejects a missing or mismatched state before calling GitHub", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const started = await start();
    const mismatch = await finish(started, "not-the-state");
    expect(mismatch.status).toBe(400);
    expect(await mismatch.text()).toContain("did not match");
    expect(sessionCookie(mismatch)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    const missing = await app.request("/auth/github/callback?code=abc&state=abc");
    expect(missing.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();

    const flipped = `${started.cookieValue.slice(0, -1)}${started.cookieValue.endsWith("a") ? "b" : "a"}`;
    const tampered = await app.request("/auth/github/callback?code=abc&state=abc", {
      headers: { cookie: `${OAUTH_COOKIE}=${flipped}` },
    });
    expect(tampered.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("denies a login outside the allowlists and accepts an org member", async () => {
    const deniedStart = await start();
    installFetch({ login: "stranger", orgs: ["other"] });
    const denied = await finish(deniedStart, deniedStart.pending.state);
    expect(denied.status).toBe(403);
    const deniedBody = await denied.text();
    expect(deniedBody).toContain("not allowed");
    expect(deniedBody).toContain("stranger");
    expect(deniedBody).not.toContain(ACCESS_TOKEN);
    expect(sessionCookie(denied)).toBeNull();
    expect(loggedText()).toContain("GitHub login denied for stranger");
    expect(loggedText()).not.toContain(ACCESS_TOKEN);

    info.mockClear();
    setGithubAuth({ allowedLogins: [], allowedOrgs: ["acme"] });
    const orgStart = await start();
    expect(orgStart.authorize.searchParams.get("scope")).toBe("read:user read:org");
    installFetch({ login: "member", orgs: ["Acme"] });
    const allowed = await finish(orgStart, orgStart.pending.state);
    expect(allowed.status).toBe(302);
    const claims = verifySession(secret, sessionCookie(allowed) ?? "", Date.now());
    expect(claims?.sub).toBe("member");
    expect(allowed.headers.getSetCookie().join("\n")).not.toContain(ACCESS_TOKEN);
    expect(loggedText()).not.toContain(ACCESS_TOKEN);
  });

  it("returns a friendly error when GitHub fails and does not log the token", async () => {
    setGithubAuth({ allowedLogins: ["octocat"], allowedOrgs: [] });
    const started = await start();
    expect(started.authorize.searchParams.get("scope")).toBe("read:user");
    installFetch({ login: "octocat", userStatus: 500 });
    const failed = await finish(started, started.pending.state);
    expect(failed.status).toBe(502);
    const body = await failed.text();
    expect(body).toContain("could not complete sign-in");
    expect(body).not.toContain(ACCESS_TOKEN);
    expect(sessionCookie(failed)).toBeNull();
    expect(loggedText()).toContain("GitHub login failed with status 500");
    expect(loggedText()).not.toContain(ACCESS_TOKEN);
    expect(loggedText()).not.toContain(CLIENT_SECRET);
  });
});

function setGithubAuth(lists: { allowedLogins: string[]; allowedOrgs: string[] }): void {
  const github: GithubAuthConfig = {
    clientId: "client-id",
    clientSecret: CLIENT_SECRET,
    allowedLogins: lists.allowedLogins,
    allowedOrgs: lists.allowedOrgs,
  };
  setAuthConfig({
    modes: ["github"],
    publicUrl: "https://board.example",
    sessionSecret: secret,
    github,
  });
}

async function start(): Promise<{
  authorize: URL;
  pending: { state: string; verifier: string; exp: number };
  cookieHeader: string;
  cookieValue: string;
  oauthCookie: string;
}> {
  const response = await app.request("/auth/github");
  expect(response.status).toBe(302);
  const oauthCookie = response.headers.get("set-cookie") ?? "";
  const cookieValue = readCookie(oauthCookie.split(";")[0], OAUTH_COOKIE) ?? "";
  const pending = openOAuthPending(secret, cookieValue, Date.now());
  expect(pending).not.toBeNull();
  return {
    authorize: new URL(response.headers.get("location") ?? "https://invalid.example"),
    pending: pending ?? { state: "", verifier: "", exp: 0 },
    cookieHeader: `${OAUTH_COOKIE}=${cookieValue}`,
    cookieValue,
    oauthCookie,
  };
}

function finish(
  started: { cookieHeader: string; pending: { state: string } },
  state: string,
): Promise<Response> {
  const params = new URLSearchParams({ code: "auth-code", state });
  return app.request(`/auth/github/callback?${params.toString()}`, {
    headers: { cookie: started.cookieHeader },
  });
}

function installFetch(options: { login: string; orgs?: string[]; userStatus?: number; orgStatus?: number }): FetchCall[] {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      body: bodyText(init?.body),
      authorization: headers.get("authorization") ?? "",
    });
    if (url === "https://github.com/login/oauth/access_token") {
      return jsonResponse({ access_token: ACCESS_TOKEN, token_type: "bearer" });
    }
    if (url === "https://api.github.com/user") {
      if ((options.userStatus ?? 200) !== 200) return new Response(ACCESS_TOKEN, { status: options.userStatus });
      return jsonResponse({ login: options.login });
    }
    if (url.startsWith("https://api.github.com/user/orgs")) {
      if ((options.orgStatus ?? 200) !== 200) return new Response(ACCESS_TOKEN, { status: options.orgStatus });
      return jsonResponse((options.orgs ?? []).map((login) => ({ login })));
    }
    return new Response("missing", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function bodyText(body: BodyInit | null | undefined): string {
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  return "";
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function sessionCookie(response: Response): string | null {
  const header = response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`));
  if (header === undefined) return null;
  return readCookie(header.split(";")[0], SESSION_COOKIE);
}

function locationPath(response: Response): string {
  const location = response.headers.get("location") ?? "";
  if (location.startsWith("/")) return location;
  return new URL(location, "https://board.example").pathname;
}

function loggedText(): string {
  return vi.mocked(console.info).mock.calls.map((call) => call.map(String).join(" ")).join("\n");
}
