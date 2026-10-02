import type { Context, MiddlewareHandler } from "hono";
import { verifyAccessJwt } from "./cloudflare-access.js";
import { getAuthConfig, type AuthConfig } from "./env.js";
import {
  readCookie,
  SESSION_COOKIE,
  verifySession,
  type SessionClaims,
} from "./session.js";

export type CloudflareAccessIdentity = {
  kind: "cloudflare-access";
  email: string;
  /** Access subject and token times; together they identify one Access login (see write-tokens.ts). */
  sub?: string;
  iat?: number;
  exp?: number;
};

export type BoardEnv = {
  Variables: {
    session: SessionClaims | undefined;
    identity: CloudflareAccessIdentity | undefined;
  };
};

const STATIC_EXTENSIONS = new Set([
  ".css",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".js",
  ".map",
  ".png",
  ".svg",
  ".txt",
  ".webmanifest",
  ".webp",
  ".woff",
  ".woff2",
]);

export const authMiddleware: MiddlewareHandler<BoardEnv> = async (c, next) => {
  const path = pathnameOf(c.req.url);
  if (isApiPath(path)) c.header("Cache-Control", "no-store");
  const config = getAuthConfig();
  if (!originAllowed(c, config.publicUrl)) {
    return c.json({ error: "cross-origin request rejected" }, 403);
  }
  if (isPublicPath(path) || config.modes.includes("none")) {
    await next();
    return;
  }
  if (config.modes.includes("cloudflare-access")) {
    const identity = await readAccessIdentity(c, config);
    if (identity === null) return rejectAccess(c, path);
    c.set("identity", identity);
    await next();
    return;
  }
  const session = readSession(c, config);
  if (session === null) {
    if (isApiPath(path)) return c.json({ error: "authentication required" }, 401);
    return c.redirect("/login", 302);
  }
  c.set("session", session);
  await next();
};

export function renderAuthHtml(
  title: string,
  message: string,
  link: { href: string; label: string } = { href: "/login", label: "Back to sign in" },
): string {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${safeTitle}</title>`,
    "</head>",
    "<body>",
    "<main>",
    `<h1>${safeTitle}</h1>`,
    `<p>${safeMessage}</p>`,
    `<p><a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a></p>`,
    "</main>",
    "</body>",
    "</html>",
  ].join("");
}

export function isPublicPath(pathname: string): boolean {
  if (pathname === "/login" || pathname === "/login/") return true;
  if (pathname === "/healthz" || pathname === "/readyz" || pathname === "/favicon.ico") return true;
  if (pathname.startsWith("/auth/")) return true;
  if (pathname.startsWith("/assets/")) return true;
  // API responses are never public because of a file extension (initiative images end in .png).
  if (isApiPath(pathname)) return false;
  const slash = pathname.lastIndexOf("/");
  const base = slash === -1 ? pathname : pathname.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  return STATIC_EXTENSIONS.has(base.slice(dot).toLowerCase());
}

export function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

export async function readAccessIdentity(c: Context, config: AuthConfig): Promise<CloudflareAccessIdentity | null> {
  const access = config.cloudflareAccess;
  if (access === undefined) return null;
  // The JWT header is the only credential. CF_Authorization and
  // Cf-Access-Authenticated-User-Email are not proof of identity.
  const token = readJwtAssertion(c.req.header(ACCESS_JWT_HEADER));
  if (token === null) return null;
  const result = await verifyAccessJwt(token, access, Date.now());
  if (!result.ok) return null;
  return {
    kind: "cloudflare-access",
    email: result.identity.email,
    sub: result.identity.sub,
    ...(result.token.iat === undefined ? {} : { iat: result.token.iat }),
    exp: result.token.exp,
  };
}

function readJwtAssertion(value: string | undefined): string | null {
  if (value === undefined) return null;
  const token = value.trim();
  if (token.length === 0 || token.length > 8192) return null;
  if (token.includes(",") || /\s/.test(token)) return null;
  return token;
}

function rejectAccess(c: Context<BoardEnv>, path: string): Response {
  if (isApiPath(path)) return c.json({ error: "authentication required" }, 401);
  return c.html(
    renderAuthHtml("Access denied", "Sign-in is handled by Cloudflare Access.", {
      href: "/cdn-cgi/access/logout",
      label: "Sign out of Cloudflare Access",
    }),
    403,
  );
}

function readSession(c: Context<BoardEnv>, config: AuthConfig): SessionClaims | null {
  if (config.sessionSecret === undefined) return null;
  const token = readCookie(c.req.header("cookie"), SESSION_COOKIE);
  if (token === null) return null;
  return verifySession(config.sessionSecret, token, Date.now());
}

function originAllowed(c: Context, publicUrl: string | undefined): boolean {
  const method = c.req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;
  const origin = c.req.header("origin");
  const referer = c.req.header("referer");
  const hasOrigin = origin !== undefined && origin.length > 0;
  const hasReferer = referer !== undefined && referer.length > 0;
  // With a configured public URL, compare full origins. Without one (none
  // mode for local use), fall back to a same-host check against Host.
  const host = c.req.header("host");
  const matches = (value: string): boolean => {
    try {
      const url = new URL(value);
      if (publicUrl !== undefined) return url.origin === new URL(publicUrl).origin;
      return host !== undefined && url.host === host;
    } catch {
      return false;
    }
  };
  if (hasOrigin) {
    if (origin === "null") return false;
    return matches(origin);
  }
  if (hasReferer) return matches(referer);
  return true;
}

function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "/";
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
