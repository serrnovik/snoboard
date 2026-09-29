import { readFileSync } from "node:fs";

export type AuthMode = "password" | "github" | "none";

export type GithubAuthConfig = {
  clientId: string;
  clientSecret: string;
  allowedLogins: readonly string[];
  allowedOrgs: readonly string[];
};

export type AuthConfig = {
  modes: readonly AuthMode[];
  publicUrl?: string;
  sessionSecret?: Buffer;
  passwordHash?: string;
  github?: GithubAuthConfig;
};

const MODE_VALUES = new Set<AuthMode>(["password", "github", "none"]);
const NAME_PATTERN = /^[A-Za-z0-9-]{1,39}$/;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

let active: AuthConfig = unconfiguredAuth();

export function unconfiguredAuth(): AuthConfig {
  return { modes: [] };
}

export function getAuthConfig(): AuthConfig {
  return active;
}

export function setAuthConfig(config: AuthConfig): void {
  active = config;
}

export function resetAuthConfig(): void {
  active = unconfiguredAuth();
}

export function getPublicAuthView(): { password: boolean; github: boolean } {
  return {
    password: active.modes.includes("password"),
    github: active.modes.includes("github"),
  };
}

export function bootAuth(env: NodeJS.ProcessEnv): void {
  if (env.VITEST === "true") {
    active = unconfiguredAuth();
    return;
  }
  active = loadAuthConfig(env);
}

export function loadAuthConfig(env: NodeJS.ProcessEnv): AuthConfig {
  const modes = parseModes(env.SNOBOARD_AUTH_MODES);
  if (modes.includes("none")) {
    if (env.SNOBOARD_AUTH_ALLOW_NONE?.trim() !== "true") {
      invalid("SNOBOARD_AUTH_ALLOW_NONE must be true when none is configured");
    }
    return { modes, publicUrl: optionalPublicUrl(env.SNOBOARD_PUBLIC_URL) };
  }

  const needsSession = modes.includes("password") || modes.includes("github");
  const publicUrl = needsSession ? requirePublicUrl(env.SNOBOARD_PUBLIC_URL) : undefined;
  const sessionSecret = needsSession ? readSecret(env.SNOBOARD_SESSION_SECRET_FILE, "SNOBOARD_SESSION_SECRET_FILE") : undefined;
  const passwordHash = modes.includes("password") ? readPasswordHash(env.SNOBOARD_PASSWORD_HASH_FILE) : undefined;
  const github = modes.includes("github") ? readGithub(env) : undefined;
  return { modes, publicUrl, sessionSecret, passwordHash, github };
}

export function isArgon2idHash(value: string): boolean {
  const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$[A-Za-z0-9+/=_-]{16,}\$[A-Za-z0-9+/=_-]{16,}$/.exec(value);
  if (match === null) return false;
  const memory = Number(match[1]);
  const time = Number(match[2]);
  const parallel = Number(match[3]);
  if (!Number.isSafeInteger(memory) || !Number.isSafeInteger(time) || !Number.isSafeInteger(parallel)) return false;
  return memory >= 19456 && time >= 2 && parallel >= 1;
}

function parseModes(raw: string | undefined): AuthMode[] {
  if (raw === undefined || raw.trim() === "") invalid("SNOBOARD_AUTH_MODES is required");
  const modes: AuthMode[] = [];
  for (const part of raw.split(",")) {
    const mode = part.trim().toLowerCase();
    if (mode.length === 0) continue;
    if (!isAuthMode(mode)) invalid("SNOBOARD_AUTH_MODES contains an unknown mode");
    if (!modes.includes(mode)) modes.push(mode);
  }
  if (modes.length === 0) invalid("SNOBOARD_AUTH_MODES is empty");
  if (modes.includes("none") && modes.length > 1) {
    invalid("SNOBOARD_AUTH_MODES: none cannot be combined with other modes");
  }
  return modes;
}

function isAuthMode(value: string): value is AuthMode {
  return MODE_VALUES.has(value as AuthMode);
}

function optionalPublicUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return requirePublicUrl(value);
}

function requirePublicUrl(value: string | undefined): string {
  if (value === undefined || value.trim() === "") invalid("SNOBOARD_PUBLIC_URL is required");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    invalid("SNOBOARD_PUBLIC_URL is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    invalid("SNOBOARD_PUBLIC_URL must be http or https");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    invalid("SNOBOARD_PUBLIC_URL must not include credentials");
  }
  return url.origin;
}

function readPasswordHash(filePath: string | undefined): string {
  const hash = readText(filePath, "SNOBOARD_PASSWORD_HASH_FILE");
  if (!isArgon2idHash(hash)) invalid("SNOBOARD_PASSWORD_HASH_FILE must be an argon2id hash");
  return hash;
}

function readGithub(env: NodeJS.ProcessEnv): GithubAuthConfig {
  const clientId = env.SNOBOARD_GITHUB_CLIENT_ID?.trim() ?? "";
  if (!CLIENT_ID_PATTERN.test(clientId)) invalid("SNOBOARD_GITHUB_CLIENT_ID is invalid");
  const clientSecret = readText(env.SNOBOARD_GITHUB_CLIENT_SECRET_FILE, "SNOBOARD_GITHUB_CLIENT_SECRET_FILE");
  if (clientSecret.length < 8 || clientSecret.length > 512) {
    invalid("SNOBOARD_GITHUB_CLIENT_SECRET_FILE is invalid");
  }
  const allowedLogins = parseNameList(env.SNOBOARD_ALLOWED_GITHUB_LOGINS, "SNOBOARD_ALLOWED_GITHUB_LOGINS");
  const allowedOrgs = parseNameList(env.SNOBOARD_ALLOWED_GITHUB_ORGS, "SNOBOARD_ALLOWED_GITHUB_ORGS");
  if (allowedLogins.length === 0 && allowedOrgs.length === 0) {
    invalid("GitHub login requires SNOBOARD_ALLOWED_GITHUB_LOGINS or SNOBOARD_ALLOWED_GITHUB_ORGS");
  }
  return { clientId, clientSecret, allowedLogins, allowedOrgs };
}

function parseNameList(value: string | undefined, label: string): string[] {
  if (value === undefined || value.trim() === "") return [];
  const names: string[] = [];
  for (const part of value.split(",")) {
    const name = part.trim();
    if (name.length === 0) continue;
    if (!NAME_PATTERN.test(name)) invalid(`${label} contains an invalid name`);
    const lower = name.toLowerCase();
    if (!names.includes(lower)) names.push(lower);
  }
  return names;
}

function readSecret(filePath: string | undefined, label: string): Buffer {
  const bytes = readBytes(filePath, label);
  let end = bytes.length;
  if (end > 0 && bytes[end - 1] === 0x0a) {
    end -= 1;
    if (end > 0 && bytes[end - 1] === 0x0d) end -= 1;
  }
  if (end < 32) invalid(`${label} must be at least 32 bytes`);
  return Buffer.from(bytes.subarray(0, end));
}

function readText(filePath: string | undefined, label: string): string {
  const bytes = readBytes(filePath, label);
  const trimmed = bytes.toString("utf8").trim();
  if (trimmed.length === 0) invalid(`${label} is empty`);
  if (trimmed.includes("\n") || trimmed.includes("\r")) invalid(`${label} must be a single line`);
  return trimmed;
}

function readBytes(filePath: string | undefined, label: string): Buffer {
  if (filePath === undefined || filePath.trim() === "") invalid(`${label} is required`);
  try {
    return readFileSync(filePath.trim());
  } catch {
    invalid(`${label} is unreadable`);
  }
}

function invalid(message: string): never {
  throw new Error(`Invalid Snoboard auth environment: ${message}`);
}
