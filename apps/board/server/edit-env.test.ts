import { createSign, generateKeyPairSync, randomBytes, type JsonWebKey, type KeyObject } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { buildGraph, loadConfig, type Snapshot } from "snoboard";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetAuthConfig, setAuthConfig, type CloudflareAccessConfig } from "./auth/env.js";
import { SESSION_COOKIE, signSession } from "./auth/session.js";
import {
  bootEditConfig,
  directBranchPatterns,
  editPermissions,
  getEditConfig,
  loadEditConfig,
  mayPushDirect,
  resetEditConfig,
  setEditConfig,
  type EditActor,
  type EditSettings,
} from "./edit-env.js";
import { app } from "./index.js";
import { resetStore, seedStore } from "./store.js";

const sessionSecret = randomBytes(32);
const dirs: string[] = [];

const access: CloudflareAccessConfig = {
  teamDomain: "example.cloudflareaccess.com",
  audiences: ["audience-tag"],
  allowedEmails: ["ada@example.com"],
  allowedEmailDomains: [],
  allowedGroups: [],
};

afterEach(async () => {
  resetEditConfig();
  resetAuthConfig();
  resetStore();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("edit environment", () => {
  it("is off when modes are unset or blank", () => {
    expect(loadEditConfig({})).toEqual({ enabled: false, modes: [], botTokenConfigured: false });
    expect(loadEditConfig({ SNOBOARD_EDIT_MODES: "  " })).toEqual({
      enabled: false,
      modes: [],
      botTokenConfigured: false,
    });
  });

  it("parses modes, branches, and whether a bot token file exists", async () => {
    const dir = await makeDir();
    const tokenFile = path.join(dir, "bot");
    await writeFile(tokenFile, "super-secret-token\n");
    expect(
      loadEditConfig({
        SNOBOARD_EDIT_MODES: " PR, direct, pr ",
        SNOBOARD_EDIT_BASE_BRANCH: "release",
        SNOBOARD_EDIT_DIRECT_BRANCH: "live",
        SNOBOARD_EDIT_BOT_TOKEN_FILE: tokenFile,
      }),
    ).toEqual({
      enabled: true,
      modes: ["pr", "direct"],
      baseBranch: "release",
      directBranch: "live",
      botTokenConfigured: true,
    });
    const loaded = JSON.stringify(
      loadEditConfig({
        SNOBOARD_EDIT_MODES: "pr",
        SNOBOARD_EDIT_BOT_TOKEN_FILE: path.join(dir, "missing"),
      }),
    );
    expect(loaded).not.toContain("super-secret-token");
    expect(loaded).toContain('"botTokenConfigured":false');
    const source = readFileSync(new URL("./edit-env.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/readFile/);
  });

  it("fails at boot when direct is enabled without a branch", () => {
    expect(() => loadEditConfig({ SNOBOARD_EDIT_MODES: "direct" })).toThrow(
      /SNOBOARD_EDIT_DIRECT_BRANCH is required when direct is enabled/,
    );
    expect(() => bootEditConfig({ SNOBOARD_EDIT_MODES: "direct" })).toThrow(
      /SNOBOARD_EDIT_DIRECT_BRANCH is required when direct is enabled/,
    );
    expect(() =>
      loadEditConfig({ SNOBOARD_EDIT_MODES: "direct", SNOBOARD_EDIT_DIRECT_BRANCH: "bad branch" }),
    ).toThrow(/SNOBOARD_EDIT_DIRECT_BRANCH is not a valid branch name/);
    expect(() => loadEditConfig({ SNOBOARD_EDIT_MODES: "ship" })).toThrow(
      /SNOBOARD_EDIT_MODES contains an unknown mode/,
    );
  });

  it("leaves editing off when vitest boots", () => {
    setEditConfig({ enabled: true, modes: ["pr"], botTokenConfigured: false });
    bootEditConfig({ VITEST: "true", SNOBOARD_EDIT_MODES: "direct" });
    expect(getEditConfig()).toEqual({ enabled: false, modes: [], botTokenConfigured: false });
  });

  it("decides submit access for each identity", () => {
    const off = settings([]);
    const on = settings(["pr", "direct"]);
    const bot = settings(["direct"], true);
    const actors: EditActor[] = ["anonymous", "password", "github", "cloudflare-access"];
    expect(actors.map((actor) => editPermissions(off, actor))).toEqual([
      { canSubmit: false, needsGithubWrite: false },
      { canSubmit: false, needsGithubWrite: false },
      { canSubmit: false, needsGithubWrite: false },
      { canSubmit: false, needsGithubWrite: false },
    ]);
    expect(editPermissions(on, "anonymous")).toEqual({ canSubmit: false, needsGithubWrite: false });
    expect(editPermissions(on, "password")).toEqual({ canSubmit: false, needsGithubWrite: false });
    expect(editPermissions(on, "cloudflare-access")).toEqual({ canSubmit: false, needsGithubWrite: false });
    expect(editPermissions(on, "github")).toEqual({ canSubmit: true, needsGithubWrite: true });
    expect(editPermissions(bot, "password")).toEqual({ canSubmit: true, needsGithubWrite: false });
    expect(editPermissions(bot, "cloudflare-access")).toEqual({ canSubmit: true, needsGithubWrite: false });
    // Access + write-connect: connect when there is no bot, bot or own token otherwise.
    expect(editPermissions(on, "cloudflare-access", { githubWriteConnect: true })).toEqual({
      canSubmit: true,
      needsGithubWrite: true,
    });
    expect(editPermissions(bot, "cloudflare-access", { githubWriteConnect: true })).toEqual({
      canSubmit: true,
      needsGithubWrite: false,
    });
    expect(editPermissions(on, "password", { githubWriteConnect: true })).toEqual({ canSubmit: false, needsGithubWrite: false });
    expect(editPermissions(bot, "github")).toEqual({ canSubmit: true, needsGithubWrite: true });
  });
});

describe("directBranches", () => {
  it("defaults to directBranch only; the default branch is not implied", () => {
    const settings = loadEditConfig({ SNOBOARD_EDIT_MODES: "pr,direct", SNOBOARD_EDIT_DIRECT_BRANCH: "live" });
    expect(directBranchPatterns(settings)).toEqual(["live"]);
    expect(mayPushDirect(settings, "live")).toBe(true);
    expect(mayPushDirect(settings, "main")).toBe(false);
  });

  it("parses comma-separated globs and matches across slashes", () => {
    const settings = loadEditConfig({
      SNOBOARD_EDIT_MODES: "direct",
      SNOBOARD_EDIT_DIRECT_BRANCH: "main",
      SNOBOARD_EDIT_DIRECT_BRANCHES: "main, feat/*, initiative/*",
    });
    expect(settings.directBranches).toEqual(["main", "feat/*", "initiative/*"]);
    expect(mayPushDirect(settings, "feat/a/b")).toBe(true);
    expect(mayPushDirect(settings, "initiative/x")).toBe(true);
    expect(mayPushDirect(settings, "fix/y")).toBe(false);
    expect(mayPushDirect(settings, "feat")).toBe(false);
  });

  it("allows nothing when direct is off, even with patterns", () => {
    const settings = loadEditConfig({ SNOBOARD_EDIT_MODES: "pr", SNOBOARD_EDIT_DIRECT_BRANCHES: "*" });
    expect(directBranchPatterns(settings)).toEqual([]);
    expect(mayPushDirect(settings, "main")).toBe(false);
  });

  it("refuses invalid patterns", () => {
    for (const bad of ["-x", "a..b", "a b", "feat/*.lock", "refs/heads/*"]) {
      expect(() =>
        loadEditConfig({
          SNOBOARD_EDIT_MODES: "direct",
          SNOBOARD_EDIT_DIRECT_BRANCH: "main",
          SNOBOARD_EDIT_DIRECT_BRANCHES: bad,
        }),
      ).toThrow(/invalid branch pattern/);
    }
  });
});

describe("GET /api/edit-config", () => {
  afterEach(() => {
    resetAuthConfig();
  });

  function usePasswordAuth(): void {
    setAuthConfig({
      modes: ["password", "github"],
      publicUrl: "http://localhost:3000",
      sessionSecret,
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$aaaaaaaaaaaaaaaa$bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
  }

  it("says editing is off when modes are unset", async () => {
    usePasswordAuth();
    setEditConfig(loadEditConfig({}));
    const response = await app.request("/api/edit-config", authed("password", "reader"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      enabled: false,
      modes: [],
      baseBranch: "main",
      defaultBranch: "main",
      canSubmit: false,
      needsGithubWrite: false,
      defaultMode: "pr",
      issues: {},
      createProviders: [],
    });
  });

  it("with ?ref= names the branch and whether direct may push to it", async () => {
    usePasswordAuth();
    setEditConfig(
      loadEditConfig({
        SNOBOARD_EDIT_MODES: "pr,direct",
        SNOBOARD_EDIT_DIRECT_BRANCH: "main",
        SNOBOARD_EDIT_DIRECT_BRANCHES: "main,feat/*",
      }),
    );
    const allowed = await app.request("/api/edit-config?ref=feat%2Fx", authed("password", "reader"));
    expect(await allowed.json()).toMatchObject({ branch: "feat/x", directAllowed: true });
    const refused = await app.request("/api/edit-config?ref=release", authed("password", "reader"));
    expect(await refused.json()).toMatchObject({ branch: "release", directAllowed: false });
    const invalid = await app.request("/api/edit-config?ref=-bad", authed("password", "reader"));
    const body = (await invalid.json()) as Record<string, unknown>;
    expect(body.branch).toBeUndefined();
    expect(body.directAllowed).toBeUndefined();
  });

  it("requires authentication", async () => {
    usePasswordAuth();
    const response = await app.request("/api/edit-config");
    expect(response.status).toBe(401);
  });

  it("reports branches, the default mode, and each signed-in identity", async () => {
    usePasswordAuth();
    seedBranch("develop");
    setEditConfig(loadEditConfig({ SNOBOARD_EDIT_MODES: "pr,direct", SNOBOARD_EDIT_DIRECT_BRANCH: "live" }));
    const password = await app.request("/api/edit-config", authed("password", "reader"));
    expect(await password.json()).toEqual({
      enabled: true,
      modes: ["pr", "direct"],
      baseBranch: "develop",
      directBranch: "live",
      defaultBranch: "develop",
      canSubmit: false,
      needsGithubWrite: false,
      defaultMode: "direct",
      issues: {},
      createProviders: [],
    });

    const github = await app.request("/api/edit-config", authed("github", "octocat"));
    expect(await github.json()).toMatchObject({
      canSubmit: true,
      needsGithubWrite: true,
      defaultMode: "direct",
      baseBranch: "develop",
    });

    setEditConfig(
      loadEditConfig({
        SNOBOARD_EDIT_MODES: "pr",
        SNOBOARD_EDIT_BASE_BRANCH: "release",
        SNOBOARD_EDIT_BOT_TOKEN_FILE: await writeBotToken(),
      }),
    );
    const withBot = await app.request("/api/edit-config", authed("password", "reader"));
    const body = await withBot.json();
    expect(body).toEqual({
      enabled: true,
      modes: ["pr"],
      baseBranch: "release",
      defaultBranch: "develop",
      canSubmit: true,
      needsGithubWrite: false,
      defaultMode: "pr",
      issues: {},
      createProviders: [],
      csrf: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(JSON.stringify(body)).not.toContain("super-secret-token");
  });

  it("lets Cloudflare Access users submit only when a bot token exists", async () => {
    const signing = makeKey("key-a");
    installCerts([signing.jwk]);
    setAuthConfig({ modes: ["cloudflare-access"], cloudflareAccess: access });
    setEditConfig(loadEditConfig({ SNOBOARD_EDIT_MODES: "direct", SNOBOARD_EDIT_DIRECT_BRANCH: "main" }));
    const headers = { "cf-access-jwt-assertion": signAccess(signing) };
    const withoutBot = await app.request("/api/edit-config", { headers });
    expect(withoutBot.status).toBe(200);
    expect(await withoutBot.json()).toMatchObject({
      canSubmit: false,
      needsGithubWrite: false,
      defaultMode: "direct",
    });

    setEditConfig(
      loadEditConfig({
        SNOBOARD_EDIT_MODES: "direct",
        SNOBOARD_EDIT_DIRECT_BRANCH: "main",
        SNOBOARD_EDIT_BOT_TOKEN_FILE: await writeBotToken(),
      }),
    );
    const withBot = await app.request("/api/edit-config", { headers });
    expect(await withBot.json()).toMatchObject({
      canSubmit: true,
      needsGithubWrite: false,
      enabled: true,
    });
  });
});

function settings(modes: EditSettings["modes"], botTokenConfigured = false): EditSettings {
  return {
    enabled: modes.length > 0,
    modes,
    ...(modes.includes("direct") ? { directBranch: "main" } : {}),
    botTokenConfigured,
  };
}

function authed(method: "password" | "github", sub: string): RequestInit {
  const iat = Date.now();
  const token = signSession(sessionSecret, { sub, method, iat, exp: iat + 60 * 60 * 1000 });
  return { headers: { cookie: `${SESSION_COOKIE}=${token}` } };
}

function seedBranch(name: string): void {
  const config = loadConfig(`defaultBranch: ${name}\n`);
  const snapshot: Snapshot = {
    generatedAt: "2026-10-01T00:00:00.000Z",
    refs: [],
    items: [],
    legacy: [],
    errors: [],
    graph: buildGraph([], config),
  };
  seedStore(snapshot, config);
}

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "snoboard-edit-"));
  dirs.push(dir);
  return dir;
}

async function writeBotToken(): Promise<string> {
  const dir = await makeDir();
  const tokenFile = path.join(dir, "bot");
  await writeFile(tokenFile, "super-secret-token\n");
  return tokenFile;
}

function makeKey(kid: string): { kid: string; privateKey: KeyObject; jwk: JsonWebKey & { kid: string } } {
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

function signAccess(pair: { kid: string; privateKey: KeyObject }): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: pair.kid, typ: "JWT" })).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({
      aud: ["audience-tag"],
      iss: "https://example.cloudflareaccess.com",
      exp: now + 3600,
      nbf: now - 30,
      email: "ada@example.com",
      sub: "user-1",
    }),
  ).toString("base64url");
  const input = `${header}.${body}`;
  const signature = createSign("RSA-SHA256").update(input).end().sign(pair.privateKey);
  return `${input}.${signature.toString("base64url")}`;
}

function installCerts(keys: JsonWebKey[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ keys }), { status: 200, headers: { "content-type": "application/json" } })),
  );
}