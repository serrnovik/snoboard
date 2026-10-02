import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../index.js";
import { resetEditConfig, setEditConfig } from "../edit-env.js";
import { resetActiveRepos, setActiveRepos } from "../repos-config.js";
import {
  DEFAULT_WRITE_TOKEN_TTL_MS,
  loadAuthConfig,
  MAX_WRITE_TOKEN_TTL_MS,
  parseWriteTokenTtl,
  resetAuthConfig,
  setAuthConfig,
  type AuthConfig,
} from "./env.js";
import { OAUTH_COOKIE, openOAuthPending, resetGithubLimits, setGithubLogger } from "./github.js";
import type { BoardEnv } from "./middleware.js";
import { readCookie, SESSION_COOKIE, signSession, verifySession, type SessionClaims } from "./session.js";
import {
  bootWriteTokens,
  clearWriteToken,
  getWriteToken,
  resetWriteTokens,
  setWriteTokenLogger,
  storeWriteToken,
  WRITE_COOKIE,
  writeTokenCount,
  writeTokenFilePath,
} from "./write-tokens.js";

const TOKEN = "synthetic-gho-token-0123456789abcdef";
const secret = randomBytes(32);
const dirs: string[] = [];
const warnings: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "snoboard-wt-"));
  dirs.push(dir);
  return dir;
}

function githubAuth(extra: Partial<AuthConfig> = {}): AuthConfig {
  return {
    modes: ["github"],
    publicUrl: "https://board.example",
    sessionSecret: secret,
    github: { clientId: "client-id", clientSecret: "synthetic-client-secret", allowedLogins: ["octocat"], allowedOrgs: [] },
    ...extra,
  };
}

function session(sub = "octocat", iat = Date.now(), lifetime = 30 * 24 * 60 * 60 * 1000): SessionClaims {
  return { sub, method: "github", iat, exp: iat + lifetime };
}

async function probe(claims: SessionClaims, handle: string, now = Date.now()): Promise<string | null> {
  const router = new Hono<BoardEnv>();
  router.get("/api/probe", (c) => {
    c.set("session", claims);
    return c.json({ token: getWriteToken(c, now)?.token ?? null });
  });
  const response = await router.request("/api/probe", {
    headers: { cookie: `${SESSION_COOKIE}=${signSession(secret, claims)}; ${WRITE_COOKIE}=${handle}` },
  });
  return ((await response.json()) as { token: string | null }).token;
}

beforeEach(() => {
  warnings.length = 0;
  setWriteTokenLogger({ warn: (message) => warnings.push(message) });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setWriteTokenLogger();
  setGithubLogger();
  resetAuthConfig();
  bootWriteTokens();
  resetWriteTokens();
  resetEditConfig();
  resetActiveRepos();
  resetGithubLimits();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("SNOBOARD_GITHUB_WRITE_TOKEN_TTL", () => {
  it("parses durations, defaults to 1h and caps at 12h", () => {
    expect(parseWriteTokenTtl(undefined)).toBe(DEFAULT_WRITE_TOKEN_TTL_MS);
    expect(parseWriteTokenTtl(" ")).toBe(60 * 60 * 1000);
    expect(parseWriteTokenTtl("8h")).toBe(8 * 60 * 60 * 1000);
    expect(parseWriteTokenTtl("90m")).toBe(90 * 60 * 1000);
    expect(parseWriteTokenTtl("3600")).toBe(60 * 60 * 1000);
    expect(parseWriteTokenTtl("12H")).toBe(MAX_WRITE_TOKEN_TTL_MS);
    expect(() => parseWriteTokenTtl("13h")).toThrow(/at most 12h/);
    expect(() => parseWriteTokenTtl("30s")).toThrow(/at least 1m/);
    expect(() => parseWriteTokenTtl("1d")).toThrow(/must look like/);
    expect(() => parseWriteTokenTtl("-1h")).toThrow(/must look like/);
  });

  it("keeps a token for the configured TTL but never past the session", async () => {
    setAuthConfig(githubAuth({ writeTokenTtlMs: 8 * 60 * 60 * 1000 }));
    const now = Date.now();
    const long = session("octocat", now);
    const stored = storeWriteToken(secret, long, TOKEN, now);
    expect(stored.maxAgeSeconds).toBe(8 * 60 * 60);
    expect(await probe(long, stored.handle, now + 8 * 60 * 60 * 1000 - 1)).toBe(TOKEN);
    expect(await probe(long, stored.handle, now + 8 * 60 * 60 * 1000 + 1)).toBeNull();

    const short = session("octocat", now, 2 * 60 * 60 * 1000);
    const capped = storeWriteToken(secret, short, TOKEN, now);
    expect(capped.maxAgeSeconds).toBe(2 * 60 * 60);
    expect(await probe(short, capped.handle, now + 2 * 60 * 60 * 1000 + 1)).toBeNull();
  });
});

describe("auth environment for write tokens", () => {
  function files(): { secretFile: string; clientSecretFile: string; dir: string } {
    const dir = tempDir();
    const secretFile = path.join(dir, "session");
    writeFileSync(secretFile, "abcdefghijklmnopqrstuvwxyz012345");
    const clientSecretFile = path.join(dir, "client");
    writeFileSync(clientSecretFile, "synthetic-client-secret\n");
    return { secretFile, clientSecretFile, dir };
  }

  it("reads the TTL, the encrypted-file store in the data dir, and login-requests-write", () => {
    const { secretFile, clientSecretFile, dir } = files();
    const config = loadAuthConfig({
      SNOBOARD_AUTH_MODES: "github",
      SNOBOARD_PUBLIC_URL: "https://board.example",
      SNOBOARD_SESSION_SECRET_FILE: secretFile,
      SNOBOARD_GITHUB_CLIENT_ID: "client-id",
      SNOBOARD_GITHUB_CLIENT_SECRET_FILE: clientSecretFile,
      SNOBOARD_ALLOWED_GITHUB_LOGINS: "octocat",
      SNOBOARD_GITHUB_WRITE_TOKEN_TTL: "12h",
      SNOBOARD_GITHUB_WRITE_TOKEN_STORE: "encrypted-file",
      SNOBOARD_GITHUB_LOGIN_REQUESTS_WRITE: "true",
      SNOBOARD_DATA_DIR: dir,
    });
    expect(config.writeTokenTtlMs).toBe(12 * 60 * 60 * 1000);
    expect(config.writeTokenStore).toEqual({ kind: "encrypted-file", filePath: path.join(dir, "github-write-tokens.enc") });
    expect(config.githubLoginRequestsWrite).toBe(true);
  });

  it("refuses encrypted-file without a session secret file, and unknown stores", () => {
    const { clientSecretFile } = files();
    const access = {
      SNOBOARD_AUTH_MODES: "cloudflare-access",
      SNOBOARD_CF_ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
      SNOBOARD_CF_ACCESS_AUD: "aud",
      SNOBOARD_ALLOWED_EMAILS: "ada@example.com",
      SNOBOARD_GITHUB_WRITE_CONNECT: "true",
      SNOBOARD_PUBLIC_URL: "https://board.example",
      SNOBOARD_GITHUB_CLIENT_ID: "client-id",
      SNOBOARD_GITHUB_CLIENT_SECRET_FILE: clientSecretFile,
    };
    expect(() => loadAuthConfig({ ...access, SNOBOARD_GITHUB_WRITE_TOKEN_STORE: "encrypted-file" })).toThrow(
      /needs SNOBOARD_SESSION_SECRET_FILE/,
    );
    expect(() =>
      loadAuthConfig({ SNOBOARD_AUTH_MODES: "none", SNOBOARD_AUTH_ALLOW_NONE: "true", SNOBOARD_GITHUB_WRITE_TOKEN_STORE: "encrypted-file" }),
    ).toThrow(/needs SNOBOARD_SESSION_SECRET_FILE/);
    expect(() => loadAuthConfig({ ...access, SNOBOARD_GITHUB_WRITE_TOKEN_STORE: "redis" })).toThrow(/memory or encrypted-file/);
    expect(() => loadAuthConfig({ ...access, SNOBOARD_GITHUB_LOGIN_REQUESTS_WRITE: "true" })).toThrow(/needs the github auth mode/);
    expect(loadAuthConfig({ ...access, SNOBOARD_GITHUB_WRITE_TOKEN_TTL: "4h" }).writeTokenTtlMs).toBe(4 * 60 * 60 * 1000);
  });

  it("refuses the encrypted-file store at boot when the session secret is missing", () => {
    setAuthConfig({ modes: ["github"], writeTokenStore: { kind: "encrypted-file", filePath: path.join(tempDir(), "t.enc") } });
    expect(() => bootWriteTokens()).toThrow(/needs a session secret/);
  });
});

describe("encrypted-file write token store", () => {
  function useFileStore(dir = tempDir()): string {
    const filePath = path.join(dir, "github-write-tokens.enc");
    setAuthConfig(githubAuth({ writeTokenStore: { kind: "encrypted-file", filePath } }));
    bootWriteTokens();
    return filePath;
  }

  it("survives a restart, with no plaintext on disk and mode 0600", async () => {
    const filePath = useFileStore();
    expect(writeTokenFilePath()).toBe(filePath);
    const claims = session();
    const stored = storeWriteToken(secret, claims, TOKEN);
    const raw = readFileSync(filePath);
    expect(raw.includes(Buffer.from(TOKEN))).toBe(false);
    expect(raw.includes(Buffer.from("octocat"))).toBe(false);
    expect(raw.includes(Buffer.from(stored.handle))).toBe(false);
    if (process.platform !== "win32") expect(statSync(filePath).mode & 0o777).toBe(0o600);

    // "Restart": memory is wiped, the file is loaded again.
    resetWriteTokens();
    expect(writeTokenCount()).toBe(0);
    bootWriteTokens();
    expect(writeTokenCount()).toBe(1);
    expect(await probe(claims, stored.handle)).toBe(TOKEN);
    // Another session cannot use the loaded entry.
    expect(await probe(session("octocat", claims.iat + 1), stored.handle)).toBeNull();
  });

  it("drops expired entries on load and rewrites the file", () => {
    const filePath = useFileStore();
    const now = Date.now();
    storeWriteToken(secret, session("octocat", now - 2 * 60 * 60 * 1000), TOKEN, now - 2 * 60 * 60 * 1000);
    storeWriteToken(secret, session("octocat", now), TOKEN, now);
    expect(writeTokenCount()).toBe(1); // the first already expired and was swept
    const before = readFileSync(filePath, "utf8");
    bootWriteTokens(now + 61 * 60 * 1000);
    expect(writeTokenCount()).toBe(0);
    expect(readFileSync(filePath, "utf8")).not.toBe(before);
  });

  it("cannot be read with another session secret and starts empty", () => {
    const dir = tempDir();
    useFileStore(dir);
    storeWriteToken(secret, session(), TOKEN);
    const filePath = path.join(dir, "github-write-tokens.enc");
    setAuthConfig(githubAuth({ sessionSecret: randomBytes(32), writeTokenStore: { kind: "encrypted-file", filePath } }));
    bootWriteTokens();
    expect(writeTokenCount()).toBe(0);
    expect(warnings.join("\n")).toContain("could not be decrypted");
    expect(warnings.join("\n")).not.toContain(TOKEN);
  });

  it("forgets the token in the file on logout / DELETE", async () => {
    const filePath = useFileStore();
    const claims = session();
    const stored = storeWriteToken(secret, claims, TOKEN);
    const router = new Hono<BoardEnv>();
    router.delete("/x", (c) => {
      c.set("session", claims);
      clearWriteToken(c);
      return c.body(null, 204);
    });
    await router.request("/x", { method: "DELETE", headers: { cookie: `${WRITE_COOKIE}=${stored.handle}` } });
    expect(writeTokenCount()).toBe(0);
    resetWriteTokens();
    bootWriteTokens();
    expect(writeTokenCount()).toBe(0);
    expect(readFileSync(filePath).includes(Buffer.from(TOKEN))).toBe(false);

    // Through the real route as well.
    const again = storeWriteToken(secret, claims, TOKEN);
    const response = await app.request("/auth/github/write", {
      method: "DELETE",
      headers: { cookie: `${SESSION_COOKIE}=${signSession(secret, claims)}; ${WRITE_COOKIE}=${again.handle}` },
    });
    expect(response.status).toBe(204);
    resetWriteTokens();
    bootWriteTokens();
    expect(writeTokenCount()).toBe(0);
  });
});

describe("SNOBOARD_GITHUB_LOGIN_REQUESTS_WRITE", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    setEditConfig({ enabled: true, modes: ["pr"], botTokenConfigured: false });
  });

  async function login(scope: string): Promise<Response> {
    const started = await app.request("/auth/github");
    const header = started.headers.getSetCookie().find((cookie) => cookie.startsWith(`${OAUTH_COOKIE}=`)) ?? "";
    const cookie = readCookie(header.split(";")[0], OAUTH_COOKIE) ?? "";
    const pending = openOAuthPending(secret, cookie);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "https://github.com/login/oauth/access_token") {
          return Response.json({ access_token: TOKEN, token_type: "bearer", scope });
        }
        if (url === "https://api.github.com/user") return Response.json({ login: "octocat" });
        return new Response("missing", { status: 404 });
      }),
    );
    return app.request(`/auth/github/callback?code=auth-code&state=${pending?.state ?? ""}`, {
      headers: { cookie: `${OAUTH_COOKIE}=${cookie}` },
    });
  }

  function cookieOf(response: Response, name: string): string | null {
    const header = response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`));
    return header === undefined ? null : readCookie(header.split(";")[0], name);
  }

  it("asks for the write scope at login and keeps the login token as the write token", async () => {
    setAuthConfig(githubAuth({ githubLoginRequestsWrite: true }));
    const started = await app.request("/auth/github");
    expect(new URL(started.headers.get("location") ?? "").searchParams.get("scope")).toBe("read:user repo");

    const response = await login("read:user,repo");
    expect(response.status).toBe(302);
    const sessionToken = cookieOf(response, SESSION_COOKIE);
    const handle = cookieOf(response, WRITE_COOKIE);
    expect(handle).not.toBeNull();
    const claims = verifySession(secret, sessionToken ?? "", Date.now());
    expect(claims).not.toBeNull();
    if (claims === null || handle === null) return;
    expect(await probe(claims, handle)).toBe(TOKEN);
    expect(response.headers.getSetCookie().join("\n")).not.toContain(TOKEN);
  });

  it("asks public_repo when every editable repo is public, and signs in without write if the scope was not granted", async () => {
    setActiveRepos([
      { id: "site", name: "Site", url: "https://example.com/site.git", edit: { modes: ["pr"], githubWriteScope: "public_repo" } },
    ]);
    setAuthConfig(githubAuth({ githubLoginRequestsWrite: true }));
    const started = await app.request("/auth/github");
    expect(new URL(started.headers.get("location") ?? "").searchParams.get("scope")).toBe("read:user public_repo");

    const response = await login("read:user");
    expect(response.status).toBe(302);
    expect(cookieOf(response, SESSION_COOKIE)).not.toBeNull();
    expect(cookieOf(response, WRITE_COOKIE)).toBeNull();
    expect(writeTokenCount()).toBe(0);
  });

  it("is off by default: login asks read scopes only and stores nothing", async () => {
    setAuthConfig(githubAuth());
    const started = await app.request("/auth/github");
    expect(new URL(started.headers.get("location") ?? "").searchParams.get("scope")).toBe("read:user");
    const response = await login("read:user,repo");
    expect(cookieOf(response, WRITE_COOKIE)).toBeNull();
    expect(writeTokenCount()).toBe(0);
  });
});
