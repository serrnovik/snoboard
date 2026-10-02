import { createHash, randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { editSettingsFor, findActiveRepo, listActiveRepos } from "../repos-config.js";
import { getAuthConfig, type GithubAuthConfig, type GithubWriteScope } from "./env.js";
import { readAccessIdentity, renderAuthHtml, type BoardEnv } from "./middleware.js";
import {
  openEncoded,
  readCookie,
  safeEqual,
  serializeCookie,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  SESSION_TTL_SECONDS,
  signEncoded,
  signSession,
  usesSecureCookie,
  verifySession,
  type SessionClaims,
} from "./session.js";
import {
  clearWriteToken,
  ownerOfAccess,
  ownerOfSession,
  storeOwnerWriteToken,
  storeWriteToken,
  writeCookie,
  type WriteOwner,
} from "./write-tokens.js";

export const OAUTH_COOKIE = "snoboard_oauth";
export const OAUTH_TTL_MS = 10 * 60 * 1000;
const OAUTH_TTL_SECONDS = OAUTH_TTL_MS / 1000;
const LOGIN_PATTERN = /^[A-Za-z0-9-]{1,39}$/;
const CODE_PATTERN = /^[\x21-\x7E]{1,512}$/;
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const ORGS_URL = "https://api.github.com/user/orgs?per_page=100";

export type OAuthPurpose = "login" | "write";

export type OAuthPending = {
  state: string;
  verifier: string;
  exp: number;
  /**
   * `login` signs in (read scopes only, unless SNOBOARD_GITHUB_LOGIN_REQUESTS_WRITE adds `scope`).
   * `write` asks for repo write access for an existing session.
   */
  purpose: OAuthPurpose;
  /** Same-origin path to return to after a write grant. */
  returnTo?: string;
  /** The session that started a write grant; the callback must present the same session. */
  sessionKey?: string;
  /** Write scope asked for: the target repo's (write), or the broadest editable repo's (login with write). */
  scope?: GithubWriteScope;
};

const MAX_RETURN_LENGTH = 512;

type AuthLogger = {
  info(message: string): void;
};

const defaultLogger: AuthLogger = {
  info(message) {
    console.info(message);
  },
};

let githubLogger: AuthLogger = defaultLogger;

export function setGithubLogger(logger?: AuthLogger): void {
  githubLogger = logger ?? defaultLogger;
}

export const GITHUB_CALLBACK_LIMIT = 60;
const CALLBACK_WINDOW_MS = 15 * 60 * 1000;
const MAX_CONSUMED_STATES = 10_000;
const consumedStates = new Map<string, number>();
let callbackStamps: number[] = [];

/** Returns false if this state was already used (or the store is full). */
export function consumeState(state: string, exp: number, now: number): boolean {
  for (const [key, expiry] of consumedStates) {
    if (expiry <= now) consumedStates.delete(key);
  }
  if (consumedStates.has(state) || consumedStates.size >= MAX_CONSUMED_STATES) return false;
  consumedStates.set(state, exp);
  return true;
}

export function callbackAllowed(now: number): boolean {
  callbackStamps = callbackStamps.filter((stamp) => now - stamp < CALLBACK_WINDOW_MS);
  if (callbackStamps.length >= GITHUB_CALLBACK_LIMIT) return false;
  callbackStamps.push(now);
  return true;
}

export function resetGithubLimits(): void {
  consumedStates.clear();
  callbackStamps = [];
}

export const githubRouter = new Hono<BoardEnv>();

githubRouter.get("/github", (c) => {
  const ready = githubReady();
  if (ready === null) return c.notFound();
  const { config, github, secret } = ready;
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const now = Date.now();
  const pending: OAuthPending = {
    state,
    verifier,
    exp: now + OAUTH_TTL_MS,
    purpose: "login",
    ...(config.githubLoginRequestsWrite === true ? { scope: loginWriteScope(github) } : {}),
  };
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header(
    "set-cookie",
    serializeCookie(OAUTH_COOKIE, sealOAuthPending(secret, pending), {
      maxAge: OAUTH_TTL_SECONDS,
      path: "/auth/github",
      secure: usesSecureCookie(config.publicUrl),
    }),
  );
  return c.redirect(authorizeUrl(config.publicUrl ?? "", github, pending), 302);
});

// Incremental write grant. Same OAuth app, same callback URL; the purpose
// rides in the signed pending cookie, never in the query string.
githubRouter.get("/github/write", async (c) => {
  const ready = writeConnectReady();
  if (ready === null) return c.notFound();
  // The target repo picks the scope (public_repo vs repo); editing must be on for that repo.
  const repoId = c.req.query("repo") ?? listActiveRepos()[0]?.id ?? "default";
  if (!/^[a-z0-9-]{1,32}$/.test(repoId) || !editSettingsFor(repoId).enabled) return c.notFound();
  const { config, github, secret } = ready;
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  const owner = await readWriteOwner(c, secret);
  if (owner === null) {
    if (accessBoard()) return writeRejected(c, "Cloudflare Access did not identify you. Reload the board and retry.");
    return c.redirect("/login", 302);
  }
  const pending: OAuthPending = {
    state: randomBytes(32).toString("base64url"),
    verifier: randomBytes(32).toString("base64url"),
    exp: Date.now() + OAUTH_TTL_MS,
    purpose: "write",
    returnTo: safeReturnPath(c.req.query("return"), config.publicUrl ?? ""),
    sessionKey: owner.key,
    scope: findActiveRepo(repoId)?.edit.githubWriteScope ?? writeScopeOf(github),
  };
  c.header(
    "set-cookie",
    serializeCookie(OAUTH_COOKIE, sealOAuthPending(secret, pending), {
      maxAge: OAUTH_TTL_SECONDS,
      path: "/auth/github",
      secure: usesSecureCookie(config.publicUrl),
    }),
  );
  return c.redirect(authorizeUrl(config.publicUrl ?? "", github, pending), 302);
});

githubRouter.delete("/github/write", async (c) => {
  const ready = writeConnectReady();
  if (ready === null) return c.notFound();
  c.header("Cache-Control", "no-store");
  // /auth/* skips the Access middleware; verify the Access token here so the
  // right owner's token is dropped (the handle cookie alone still clears its own).
  if (accessBoard()) {
    const identity = await readAccessIdentity(c, ready.config);
    if (identity !== null) c.set("identity", identity);
  }
  clearWriteToken(c);
  return c.body(null, 204);
});

githubRouter.get("/github/callback", async (c) => {
  const ready = writeConnectReady();
  if (ready === null) return c.notFound();
  const { config, github, secret } = ready;
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  const pending = openPendingCookie(c, secret);
  clearOauthCookie(c, config.publicUrl ?? "");
  if (pending === null) return stateRejected(c);
  // On an Access board the OAuth client only connects write access, never signs in.
  if (pending.purpose === "login" && githubReady() === null) return stateRejected(c);
  const queryState = c.req.query("state") ?? "";
  if (!safeEqual(queryState, pending.state)) return stateRejected(c);
  // The pending cookie is a stateless signed blob, so a copy could be replayed
  // until it expires. Consume each state once, and cap callbacks globally so
  // floods can't turn into outbound GitHub requests.
  if (!consumeState(pending.state, pending.exp, Date.now())) return stateRejected(c);
  if (!callbackAllowed(Date.now())) {
    c.header("Retry-After", "60");
    return c.html(renderAuthHtml("Too many sign-in attempts", "Try again in a few minutes."), 429);
  }
  if (c.req.query("error") !== undefined) return stateRejected(c);
  const code = c.req.query("code") ?? "";
  if (!CODE_PATTERN.test(code)) return stateRejected(c);
  // A write grant needs the same signed-in GitHub session that started it.
  // Checked before the code exchange so a stray write callback costs no GitHub call.
  let writer: WriteOwner | null = null;
  if (pending.purpose === "write") {
    writer = await readWriteOwner(c, secret);
    if (writer === null || pending.sessionKey === undefined || !safeEqual(writer.key, pending.sessionKey)) {
      return writeRejected(c, "Your board session changed. Sign in again, then retry.");
    }
  }
  const exchanged = await exchangeCode(github, `${config.publicUrl}/auth/github/callback`, code, pending.verifier);
  if (exchanged === null) return unavailable(c);
  const accessToken = exchanged.token;
  const login = await fetchLogin(accessToken);
  if (login === null) return unavailable(c);
  if (writer !== null) {
    if (writer.accessEmail === undefined) {
      if (login.toLowerCase() !== writer.bind.toLowerCase()) {
        githubLogger.info("GitHub write grant rejected: login does not match the session");
        return writeRejected(c, "GitHub signed in as a different account than this board session.");
      }
    } else if (github.allowedLogins.length > 0 && !github.allowedLogins.includes(login.toLowerCase())) {
      // Access boards: GitHub repo permissions decide who can write; the
      // optional SNOBOARD_ALLOWED_GITHUB_LOGINS narrows it further.
      githubLogger.info(`GitHub write grant rejected for ${writer.accessEmail}: ${login} is not an allowed GitHub login`);
      return writeRejected(c, `The GitHub account ${login} is not allowed to submit edits on this Snoboard.`);
    }
    if (!grantsWrite(exchanged.scope, pending.scope ?? writeScopeOf(github))) {
      githubLogger.info("GitHub write grant rejected: write scope was not granted");
      return writeRejected(c, "GitHub did not grant write access.");
    }
    let stored: { handle: string; maxAgeSeconds: number };
    try {
      // The token was just checked against GET /user; `login` is who it belongs to.
      stored = storeOwnerWriteToken(secret, writer, accessToken, writer.accessEmail === undefined ? writer.bind : login);
    } catch {
      return unavailable(c);
    }
    if (writer.accessEmail !== undefined) {
      githubLogger.info(`GitHub write access connected for ${writer.accessEmail} as ${login}`);
    }
    c.header("set-cookie", writeCookie(stored.handle, stored.maxAgeSeconds), { append: true });
    return c.redirect(pending.returnTo ?? "/", 302);
  }
  const decision = await decideAccess(accessToken, login, github);
  if (decision === "error") return unavailable(c);
  if (decision === "deny") {
    githubLogger.info(`GitHub login denied for ${login}`);
    return c.html(
      renderAuthHtml("Sign-in denied", `The GitHub account ${login} is not allowed to open this Snoboard.`),
      403,
    );
  }
  const now = Date.now();
  const claims: SessionClaims = { sub: login, method: "github", iat: now, exp: now + SESSION_TTL_MS };
  const session = signSession(secret, claims);
  c.header(
    "set-cookie",
    serializeCookie(SESSION_COOKIE, session, {
      maxAge: SESSION_TTL_SECONDS,
      path: "/",
      secure: usesSecureCookie(config.publicUrl),
    }),
    { append: true },
  );
  // SNOBOARD_GITHUB_LOGIN_REQUESTS_WRITE: one consent. The login token becomes this
  // session's write token, only if GitHub really granted the write scope.
  if (pending.scope !== undefined && config.githubLoginRequestsWrite === true) {
    if (grantsWrite(exchanged.scope, pending.scope)) {
      try {
        const stored = storeWriteToken(secret, claims, accessToken, now);
        c.header("set-cookie", writeCookie(stored.handle, stored.maxAgeSeconds), { append: true });
      } catch {
        // Store full: the user signs in anyway and connects write access at submit.
      }
    } else {
      githubLogger.info("GitHub login did not grant the write scope; write access will be asked at submit");
    }
  }
  return c.redirect("/", 302);
});

export function sealOAuthPending(secret: Buffer, pending: OAuthPending): string {
  const encoded = Buffer.from(
    JSON.stringify({
      state: pending.state,
      verifier: pending.verifier,
      exp: pending.exp,
      purpose: pending.purpose,
      ...(pending.returnTo === undefined ? {} : { returnTo: pending.returnTo }),
      ...(pending.sessionKey === undefined ? {} : { sessionKey: pending.sessionKey }),
      ...(pending.scope === undefined ? {} : { scope: pending.scope }),
    }),
  ).toString("base64url");
  return signEncoded(secret, encoded);
}

export function openOAuthPending(secret: Buffer, token: string, now = Date.now()): OAuthPending | null {
  const encoded = openEncoded(secret, token);
  if (encoded === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const state = record.state;
  const verifier = record.verifier;
  const exp = record.exp;
  if (typeof state !== "string" || typeof verifier !== "string" || typeof exp !== "number") return null;
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(state) || !/^[A-Za-z0-9_-]{43,128}$/.test(verifier)) return null;
  if (!Number.isSafeInteger(exp) || exp <= now || exp - now > OAUTH_TTL_MS) return null;
  const purpose = record.purpose;
  if (purpose === "login") {
    if (record.returnTo !== undefined || record.sessionKey !== undefined) return null;
    if (record.scope === undefined) return { state, verifier, exp, purpose };
    if (record.scope !== "repo" && record.scope !== "public_repo") return null;
    return { state, verifier, exp, purpose, scope: record.scope };
  }
  if (purpose !== "write") return null;
  const returnTo = record.returnTo;
  const sessionKey = record.sessionKey;
  if (typeof returnTo !== "string" || !isSafeReturnPath(returnTo)) return null;
  if (typeof sessionKey !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(sessionKey)) return null;
  const scope = record.scope;
  if (scope === undefined) return { state, verifier, exp, purpose, returnTo, sessionKey };
  if (scope !== "repo" && scope !== "public_repo") return null;
  return { state, verifier, exp, purpose, returnTo, sessionKey, scope };
}

/**
 * Only same-origin absolute paths. Anything else (scheme, `//host`, backslashes,
 * control characters, a different origin after resolution) falls back to `/`.
 */
export function safeReturnPath(raw: string | undefined, publicUrl: string): string {
  if (raw === undefined || !isSafeReturnPath(raw)) return "/";
  let resolved: URL;
  try {
    resolved = new URL(raw, publicUrl);
    if (resolved.origin !== new URL(publicUrl).origin) return "/";
  } catch {
    return "/";
  }
  const path = `${resolved.pathname}${resolved.search}${resolved.hash}`;
  return isSafeReturnPath(path) ? path : "/";
}

function isSafeReturnPath(value: string): boolean {
  if (value.length === 0 || value.length > MAX_RETURN_LENGTH) return false;
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  if (value.includes("\\") || /[^!-~]/.test(value)) return false;
  return !value.startsWith("/auth/");
}

function readGithubSession(c: Context<BoardEnv>, secret: Buffer): SessionClaims | null {
  const token = readCookie(c.req.header("cookie"), SESSION_COOKIE);
  if (token === null) return null;
  const claims = verifySession(secret, token, Date.now());
  if (claims === null || claims.method !== "github") return null;
  return claims;
}

/** Who a write grant belongs to: the GitHub session, or on Access boards the verified Access login. */
async function readWriteOwner(c: Context<BoardEnv>, secret: Buffer): Promise<WriteOwner | null> {
  if (accessBoard()) {
    const identity = await readAccessIdentity(c, getAuthConfig());
    return identity === null ? null : ownerOfAccess(identity);
  }
  const session = readGithubSession(c, secret);
  return session === null ? null : ownerOfSession(session);
}

function accessBoard(): boolean {
  return getAuthConfig().modes.includes("cloudflare-access");
}

function writeScopeOf(github: GithubAuthConfig): GithubWriteScope {
  return github.writeScope ?? "repo";
}

/** GitHub reports the granted scopes; the user can deselect them on the consent screen. */
function grantsWrite(granted: string | null, wanted: GithubWriteScope): boolean {
  if (granted === null) return false;
  const scopes = granted.split(/[\s,]+/).filter((scope) => scope.length > 0);
  if (scopes.includes("repo")) return true;
  return wanted === "public_repo" && scopes.includes("public_repo");
}

function writeRejected(c: Context<BoardEnv>, message: string): Response {
  return c.html(
    renderAuthHtml("GitHub write access not connected", message, { href: "/", label: "Back to the board" }),
    403,
  );
}

function githubReady(): {
  config: ReturnType<typeof getAuthConfig>;
  github: GithubAuthConfig;
  secret: Buffer;
} | null {
  const config = getAuthConfig();
  if (!config.modes.includes("github")) return null;
  if (config.github === undefined || config.sessionSecret === undefined || config.publicUrl === undefined) return null;
  return { config, github: config.github, secret: config.sessionSecret };
}

/** GitHub sign-in, or (Access boards with SNOBOARD_GITHUB_WRITE_CONNECT) write-connect only. */
function writeConnectReady(): ReturnType<typeof githubReady> {
  const login = githubReady();
  if (login !== null) return login;
  const config = getAuthConfig();
  if (config.githubWriteConnect !== true || !config.modes.includes("cloudflare-access")) return null;
  if (config.github === undefined || config.sessionSecret === undefined || config.publicUrl === undefined) return null;
  return { config, github: config.github, secret: config.sessionSecret };
}

function authorizeUrl(publicUrl: string, github: GithubAuthConfig, pending: OAuthPending): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", github.clientId);
  url.searchParams.set("redirect_uri", `${publicUrl}/auth/github/callback`);
  url.searchParams.set("scope", scopeParam(github, pending));
  url.searchParams.set("state", pending.state);
  url.searchParams.set("code_challenge", createHash("sha256").update(pending.verifier).digest("base64url"));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("allow_signup", "false");
  return url.toString();
}

function scopeParam(github: GithubAuthConfig, pending: OAuthPending): string {
  if (pending.purpose === "write") return pending.scope ?? writeScopeOf(github);
  const read = github.allowedOrgs.length > 0 ? "read:user read:org" : "read:user";
  // Login asks for a write scope only with SNOBOARD_GITHUB_LOGIN_REQUESTS_WRITE.
  return pending.scope === undefined ? read : `${read} ${pending.scope}`;
}

/** One consent must cover every editable repo: `repo` if any of them needs it. */
function loginWriteScope(github: GithubAuthConfig): GithubWriteScope {
  const scopes = listActiveRepos()
    .filter((repo) => editSettingsFor(repo.id).enabled)
    .map((repo) => repo.edit.githubWriteScope ?? writeScopeOf(github));
  if (scopes.length === 0) return writeScopeOf(github);
  return scopes.includes("repo") ? "repo" : "public_repo";
}

function openPendingCookie(c: Context<BoardEnv>, secret: Buffer): OAuthPending | null {
  const token = readCookie(c.req.header("cookie"), OAUTH_COOKIE);
  if (token === null) return null;
  return openOAuthPending(secret, token, Date.now());
}

function clearOauthCookie(c: Context<BoardEnv>, publicUrl: string): void {
  c.header(
    "set-cookie",
    serializeCookie(OAUTH_COOKIE, "", {
      maxAge: 0,
      path: "/auth/github",
      secure: usesSecureCookie(publicUrl),
    }),
  );
}

function stateRejected(c: Context<BoardEnv>): Response {
  return c.html(
    renderAuthHtml(
      "Sign-in could not be verified",
      "The sign-in attempt expired or did not match. Start again from the login page.",
    ),
    400,
  );
}

function unavailable(c: Context<BoardEnv>): Response {
  return c.html(
    renderAuthHtml("Sign-in failed", "GitHub could not complete sign-in. Try again in a moment."),
    502,
  );
}

async function exchangeCode(
  github: GithubAuthConfig,
  redirectUri: string,
  code: string,
  verifier: string,
): Promise<{ token: string; scope: string | null } | null> {
  try {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      redirect: "error",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "snoboard",
      },
      body: new URLSearchParams({
        client_id: github.clientId,
        client_secret: github.clientSecret,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      githubLogger.info(`GitHub login failed with status ${response.status}`);
      return null;
    }
    const payload: unknown = await response.json().catch(() => null);
    const token = readAccessToken(payload);
    if (token === null) {
      githubLogger.info("GitHub login failed");
      return null;
    }
    const scope = (payload as { scope?: unknown }).scope;
    return { token, scope: typeof scope === "string" ? scope : null };
  } catch {
    githubLogger.info("GitHub login failed");
    return null;
  }
}

async function fetchLogin(accessToken: string): Promise<string | null> {
  const response = await githubApi(USER_URL, accessToken);
  if (response === null) return null;
  const payload = await response.json().catch(() => null);
  return readLogin(payload);
}

async function decideAccess(
  accessToken: string,
  login: string,
  github: GithubAuthConfig,
): Promise<"allow" | "deny" | "error"> {
  if (github.allowedLogins.includes(login.toLowerCase())) return "allow";
  if (github.allowedOrgs.length === 0) return "deny";
  const orgs = await fetchOrgLogins(accessToken);
  if (orgs === null) return "error";
  for (const org of orgs) {
    if (github.allowedOrgs.includes(org.toLowerCase())) return "allow";
  }
  return "deny";
}

async function fetchOrgLogins(accessToken: string): Promise<string[] | null> {
  const names: string[] = [];
  let url: string | null = ORGS_URL;
  for (let page = 0; page < 5 && url !== null; page += 1) {
    const response = await githubApi(url, accessToken);
    if (response === null) return null;
    const payload: unknown = await response.json().catch(() => null);
    if (!Array.isArray(payload)) return null;
    for (const entry of payload) {
      const login = readLogin(entry);
      if (login !== null) names.push(login);
    }
    url = nextOrgPage(response.headers.get("link"));
  }
  return names;
}

async function githubApi(url: string, accessToken: string): Promise<Response | null> {
  if (!url.startsWith("https://api.github.com/")) return null;
  try {
    const response = await fetch(url, {
      redirect: "error",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "snoboard",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      githubLogger.info(`GitHub login failed with status ${response.status}`);
      return null;
    }
    return response;
  } catch {
    githubLogger.info("GitHub login failed");
    return null;
  }
}

function readAccessToken(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const token = (payload as { access_token?: unknown }).access_token;
  if (typeof token !== "string" || token.length === 0 || token.length > 2048) return null;
  return token;
}

function readLogin(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const login = (payload as { login?: unknown }).login;
  if (typeof login !== "string" || !LOGIN_PATTERN.test(login)) return null;
  return login;
}

function nextOrgPage(link: string | null): string | null {
  if (link === null) return null;
  for (const part of link.split(",")) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part);
    const href = match?.[1];
    if (href === undefined) continue;
    if (!href.startsWith("https://api.github.com/")) continue;
    return href;
  }
  return null;
}
