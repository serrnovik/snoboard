import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Config, Snapshot } from "snoboard";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAuthConfig, setAuthConfig } from "./auth/env.js";
import { SESSION_COOKIE, signSession, type SessionClaims } from "./auth/session.js";
import { resetWriteTokens, storeWriteToken, WRITE_COOKIE } from "./auth/write-tokens.js";
import { resetEditConfig } from "./edit-env.js";
import { resetSubmitState } from "./edits/submit.js";
import { app } from "./index.js";
import { ISSUE_CREATE_LIMIT_PER_HOUR, resetIssueCreateLimits } from "./issues/create.js";
import { resetIssueSetup, resetVikunjaProjectCache } from "./issues/setup.js";
import { resetActiveRepos, setActiveRepos, type RepoConfig } from "./repos-config.js";
import { resetStore, seedStore } from "./store.js";

const secret = randomBytes(32);
const ORIGIN = "http://localhost:3000";
const dirs: string[] = [];

function claims(sub: string, method: "password" | "github"): SessionClaims {
  const iat = Date.now();
  return { sub, method, iat, exp: iat + 60 * 60 * 1000 };
}

function cookieFor(session: SessionClaims, writeHandle?: string): string {
  const base = `${SESSION_COOKIE}=${signSession(secret, session)}`;
  return writeHandle === undefined ? base : `${base}; ${WRITE_COOKIE}=${writeHandle}`;
}

async function secretFile(value: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "snoboard-issue-create-"));
  dirs.push(dir);
  const file = path.join(dir, "token");
  await writeFile(file, `${value}\n`);
  return file;
}

function seed(): void {
  const snapshot = { generatedAt: "2026-10-01T00:00:00.000Z", refs: [], items: [{ id: "acme-001", project: "acme" }, { id: "misc-001", project: "misc" }], legacy: [], errors: [], graph: { nodes: [], edges: [] } };
  seedStore(snapshot as unknown as Snapshot, { forge: { repo: "example/acme" } } as unknown as Config, "2026-10-01T00:00:00.000Z", "acme");
}

async function publish(options: { forgejoToken?: string; botToken?: string; vikunja?: boolean } = {}): Promise<void> {
  const repo: RepoConfig = {
    id: "acme",
    name: "Acme",
    url: "https://example.com/acme.git",
    edit: {
      modes: ["pr"],
      ...(options.botToken === undefined ? {} : { botTokenFile: await secretFile(options.botToken) }),
    },
    issues: {
      github: { repo: "example/acme" },
      forgejo: {
        baseUrl: "https://forge.example.com",
        repo: "acme/widgets",
        ...(options.forgejoToken === undefined ? {} : { tokenFile: await secretFile(options.forgejoToken) }),
      },
      ...(options.vikunja === true
        ? {
            vikunja: {
              baseUrl: "https://tasks.example.com",
              tokenFile: await secretFile("vj-secret-1"),
              projectId: 4,
              projectMap: { acme: 23 },
            },
          }
        : {}),
    },
  };
  setActiveRepos([repo]);
}

async function editConfig(cookie: string): Promise<{ csrf?: string; createProviders?: string[] }> {
  const response = await app.request("/api/repos/acme/edit-config", { headers: { cookie } });
  return (await response.json()) as { csrf?: string; createProviders?: string[] };
}

function post(cookie: string, body: unknown, origin = ORIGIN): Promise<Response> {
  return app.request("/api/repos/acme/issues/create", {
    method: "POST",
    headers: { cookie, origin, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/repos/:repo/issues/create", () => {
  beforeEach(() => {
    setAuthConfig({
      modes: ["github", "password"],
      publicUrl: ORIGIN,
      sessionSecret: secret,
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$aaaaaaaaaaaaaaaa$bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      github: { clientId: "client-id", clientSecret: "client-secret", allowedLogins: ["octocat"], allowedOrgs: [] },
    });
    seed();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetStore();
    resetAuthConfig();
    resetEditConfig();
    resetActiveRepos();
    resetIssueSetup();
    resetVikunjaProjectCache();
    resetIssueCreateLimits();
    resetSubmitState();
    resetWriteTokens();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("creates a Forgejo issue for a password user with CSRF, never leaking the token", async () => {
    await publish({ forgejoToken: "fj-secret-token", botToken: "bot-secret", vikunja: true });
    const cookie = cookieFor(claims("reader", "password"));
    const config = await editConfig(cookie);
    // GitHub needs the person's own token, so password users are offered only board-token trackers.
    expect(config.createProviders).toEqual(["fj", "vikunja"]);
    expect(JSON.stringify(config)).not.toContain("fj-secret-token");

    const calls: { url: string; auth: string | null; body: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body: String(init?.body) });
        return new Response(JSON.stringify({ number: 5, html_url: "https://forge.example.com/acme/widgets/issues/5" }), { status: 201 });
      }),
    );
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const response = await post(cookie, { provider: "fj", initiativeId: "acme-001", title: "Do it", body: "secret body text", csrf: config.csrf });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true, ref: "fj#5", url: "https://forge.example.com/acme/widgets/issues/5" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://forge.example.com/api/v1/repos/acme/widgets/issues");
    expect(calls[0]?.auth).toBe("token fj-secret-token");
    expect(calls[0]?.body).toContain("Created from Snoboard by password-user for acme-001");
    const logged = info.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(logged).toContain("snoboard: issue-create ok");
    expect(logged).toContain('ref="fj#5"');
    expect(logged).not.toContain("secret body text");
    expect(logged).not.toContain("Do it");
    expect(logged).not.toContain("fj-secret-token");
  });

  it("refuses bad CSRF, a foreign origin, read-only users, bad input, unknown initiatives and disabled trackers", async () => {
    await publish({ forgejoToken: "fj-secret-token", botToken: "bot-secret" });
    const cookie = cookieFor(claims("reader", "password"));
    const { csrf } = await editConfig(cookie);
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetchSpy);
    vi.spyOn(console, "info").mockImplementation(() => {});
    const good = { provider: "fj", initiativeId: "acme-001", title: "T", body: "", csrf };

    const badCsrf = await post(cookie, { ...good, csrf: "nope" });
    expect(badCsrf.status).toBe(403);
    expect(((await badCsrf.json()) as { code: string }).code).toBe("csrf");

    expect((await post(cookie, good, "https://evil.example.com")).status).toBe(403);

    const longTitle = await post(cookie, { ...good, title: "x".repeat(257) });
    expect(longTitle.status).toBe(400);
    const longBody = await post(cookie, { ...good, body: "x".repeat(20_001) });
    expect(longBody.status).toBe(400);

    const missing = await post(cookie, { ...good, initiativeId: "acme-999" });
    expect(missing.status).toBe(404);

    const vikunja = await post(cookie, { ...good, provider: "vikunja" });
    expect(vikunja.status).toBe(400);
    expect(((await vikunja.json()) as { code: string }).code).toBe("provider_unavailable");
    const github = await post(cookie, { ...good, provider: "gh" });
    expect(((await github.json()) as { code: string }).code).toBe("provider_unavailable");

    // Without a bot token a password user is read-only.
    await publish({ forgejoToken: "fj-secret-token" });
    const readOnly = await post(cookie, good);
    expect(readOnly.status).toBe(403);
    expect(((await readOnly.json()) as { code: string }).code).toBe("read_only");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rate-limits per person", async () => {
    await publish({ forgejoToken: "fj-secret-token", botToken: "bot-secret" });
    const cookie = cookieFor(claims("reader", "password"));
    const { csrf } = await editConfig(cookie);
    vi.spyOn(console, "info").mockImplementation(() => {});
    let number = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        number += 1;
        return new Response(JSON.stringify({ number }), { status: 201 });
      }),
    );
    const body = { provider: "fj", initiativeId: "acme-001", title: "T", body: "", csrf };
    for (let index = 0; index < ISSUE_CREATE_LIMIT_PER_HOUR; index += 1) {
      expect((await post(cookie, body)).status).toBe(201);
    }
    const limited = await post(cookie, body);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("3600");
  });

  it("asks a GitHub user to connect write access, then creates as them", async () => {
    await publish();
    const session = claims("octocat", "github");
    const cookie = cookieFor(session);
    const config = await editConfig(cookie);
    expect(config.createProviders).toEqual(["gh"]);
    vi.spyOn(console, "info").mockImplementation(() => {});
    const fetchSpy = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ number: 12, html_url: "https://github.com/example/acme/issues/12" }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const body = { provider: "gh", initiativeId: "acme-001", title: "T", body: "B", csrf: config.csrf };

    const needs = await post(cookie, body);
    expect(needs.status).toBe(401);
    expect(await needs.json()).toMatchObject({ code: "needs_github_write", needsGithubWrite: true });
    expect(fetchSpy).not.toHaveBeenCalled();

    const { handle } = storeWriteToken(secret, session, "user-write-token");
    const created = await post(cookieFor(session, handle), body);
    expect(created.status).toBe(201);
    const payload = await created.json();
    expect(payload).toEqual({ ok: true, ref: "gh#12", url: "https://github.com/example/acme/issues/12" });
    expect(JSON.stringify(payload)).not.toContain("user-write-token");
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("https://api.github.com/repos/example/acme/issues");
    expect(new Headers(fetchSpy.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer user-write-token");

    // GitHub rejecting the token drops it and asks to connect again.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "Bad credentials user-write-token" }), { status: 401 })));
    const rejected = await post(cookieFor(session, handle), body);
    expect(rejected.status).toBe(401);
    const rejectedBody = await rejected.json();
    expect(rejectedBody).toMatchObject({ needsGithubWrite: true });
    expect(JSON.stringify(rejectedBody)).not.toContain("user-write-token");
  });

  it("lists Vikunja projects with the mapped preselection and checks the chosen project", async () => {
    await publish({ forgejoToken: "fj-secret-token", botToken: "bot-secret", vikunja: true });
    const cookie = cookieFor(claims("reader", "password"));
    const { csrf } = await editConfig(cookie);
    vi.spyOn(console, "info").mockImplementation(() => {});
    const calls: { url: string; auth: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
        if (String(url).includes("/api/v1/projects?")) {
          return new Response(JSON.stringify([{ id: 4, title: "Default", hex_color: "fff" }, { id: 23, title: "Acme" }, { id: 30, title: "Other" }]), { status: 200 });
        }
        return new Response(JSON.stringify({ id: 99 }), { status: 201 });
      }),
    );

    const listed = await app.request("/api/repos/acme/issues/vikunja-projects?initiative=acme-001", { headers: { cookie } });
    expect(listed.status).toBe(200);
    const listBody = await listed.json();
    expect(listBody).toEqual({ projects: [{ id: 4, title: "Default" }, { id: 23, title: "Acme" }, { id: 30, title: "Other" }], selected: 23 });
    expect(JSON.stringify(listBody)).not.toContain("vj-secret-1");
    const fallback = (await (await app.request("/api/repos/acme/issues/vikunja-projects?initiative=misc-001", { headers: { cookie } })).json()) as { selected: number };
    expect(fallback.selected).toBe(4);
    // Cached: one list call for both requests.
    expect(calls.filter((call) => call.url.includes("/api/v1/projects?"))).toHaveLength(1);

    const base = { provider: "vikunja", title: "T", body: "", csrf };
    expect((await post(cookie, { ...base, initiativeId: "acme-001" })).status).toBe(201);
    expect(calls.at(-1)?.url).toBe("https://tasks.example.com/api/v1/projects/23/tasks");
    expect((await post(cookie, { ...base, initiativeId: "misc-001" })).status).toBe(201);
    expect(calls.at(-1)?.url).toBe("https://tasks.example.com/api/v1/projects/4/tasks");
    expect((await post(cookie, { ...base, initiativeId: "acme-001", projectId: 30 })).status).toBe(201);
    expect(calls.at(-1)?.url).toBe("https://tasks.example.com/api/v1/projects/30/tasks");
    const unknown = await post(cookie, { ...base, initiativeId: "acme-001", projectId: 777 });
    expect(unknown.status).toBe(400);
    expect(calls.at(-1)?.url).not.toContain("/777/");

    // Read-only sessions get nothing.
    await publish({ vikunja: true });
    expect((await app.request("/api/repos/acme/issues/vikunja-projects", { headers: { cookie } })).status).toBe(403);
  });
});
