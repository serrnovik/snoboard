import type { Context, MiddlewareHandler } from "hono";
import { getAuthConfig, type AuthConfig } from "./env.js";
import {
  readCookie,
  SESSION_COOKIE,
  verifySession,
  type SessionClaims,
} from "./session.js";

export type BoardEnv = {
  Variables: {
    session: SessionClaims | undefined;
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
  const session = readSession(c, config);
  if (session === null) {
    if (isApiPath(path)) return c.json({ error: "authentication required" }, 401);
    return c.redirect("/login", 302);
  }
  c.set("session", session);
  await next();
};

export function renderAuthHtml(title: string, message: string): string {
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
    '<p><a href="/login">Back to sign in</a></p>',
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
  const slash = pathname.lastIndexOf("/");
  const base = slash === -1 ? pathname : pathname.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  return STATIC_EXTENSIONS.has(base.slice(dot).toLowerCase());
}

export function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
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
