import { createHash, randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { getAuthConfig, type GithubAuthConfig } from "./env.js";
import { renderAuthHtml, type BoardEnv } from "./middleware.js";
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
} from "./session.js";

export const OAUTH_COOKIE = "snoboard_oauth";
export const OAUTH_TTL_MS = 10 * 60 * 1000;
const OAUTH_TTL_SECONDS = OAUTH_TTL_MS / 1000;
const LOGIN_PATTERN = /^[A-Za-z0-9-]{1,39}$/;
const CODE_PATTERN = /^[\x21-\x7E]{1,512}$/;
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const ORGS_URL = "https://api.github.com/user/orgs?per_page=100";

export type OAuthPending = {
  state: string;
  verifier: string;
  exp: number;
};

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
  const pending: OAuthPending = { state, verifier, exp: now + OAUTH_TTL_MS };
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

githubRouter.get("/github/callback", async (c) => {
  const ready = githubReady();
  if (ready === null) return c.notFound();
  const { config, github, secret } = ready;
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  const pending = openPendingCookie(c, secret);
  clearOauthCookie(c, config.publicUrl ?? "");
  if (pending === null) return stateRejected(c);
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
  const accessToken = await exchangeCode(github, `${config.publicUrl}/auth/github/callback`, code, pending.verifier);
  if (accessToken === null) return unavailable(c);
  const login = await fetchLogin(accessToken);
  if (login === null) return unavailable(c);
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
  const session = signSession(secret, {
    sub: login,
    method: "github",
    iat: now,
    exp: now + SESSION_TTL_MS,
  });
  c.header(
    "set-cookie",
    serializeCookie(SESSION_COOKIE, session, {
      maxAge: SESSION_TTL_SECONDS,
      path: "/",
      secure: usesSecureCookie(config.publicUrl),
    }),
    { append: true },
  );
  return c.redirect("/", 302);
});

export function sealOAuthPending(secret: Buffer, pending: OAuthPending): string {
  const encoded = Buffer.from(
    JSON.stringify({ state: pending.state, verifier: pending.verifier, exp: pending.exp }),
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
  return { state, verifier, exp };
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

function authorizeUrl(publicUrl: string, github: GithubAuthConfig, pending: OAuthPending): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", github.clientId);
  url.searchParams.set("redirect_uri", `${publicUrl}/auth/github/callback`);
  url.searchParams.set("scope", github.allowedOrgs.length > 0 ? "read:user read:org" : "read:user");
  url.searchParams.set("state", pending.state);
  url.searchParams.set("code_challenge", createHash("sha256").update(pending.verifier).digest("base64url"));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("allow_signup", "false");
  return url.toString();
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
): Promise<string | null> {
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
    return token;
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
