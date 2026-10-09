import { statSync } from "node:fs";
import { isValidBranchName, matchesBranchPatterns } from "snoboard";

export type EditMode = "pr" | "direct";

export type EditActor = "anonymous" | "password" | "github" | "cloudflare-access";

export type EditSettings = {
  enabled: boolean;
  modes: readonly EditMode[];
  baseBranch?: string;
  directBranch?: string;
  /**
   * Branches `direct` may push to when the board shows one branch (glob, `*` crosses `/`).
   * Defaults to `[directBranch]`. Empty when `direct` is off.
   */
  directBranches?: readonly string[];
  botTokenConfigured: boolean;
};

export type EditPermissions = {
  canSubmit: boolean;
  needsGithubWrite: boolean;
};

const MODE_VALUES = new Set<EditMode>(["pr", "direct"]);

let active: EditSettings = disabledEditSettings();

export function disabledEditSettings(): EditSettings {
  return { enabled: false, modes: [], botTokenConfigured: false };
}

export function getEditConfig(): EditSettings {
  return copySettings(active);
}

export function setEditConfig(settings: EditSettings): void {
  active = copySettings(settings);
}

function copySettings(settings: EditSettings): EditSettings {
  return {
    ...settings,
    modes: [...settings.modes],
    ...(settings.directBranches === undefined ? {} : { directBranches: [...settings.directBranches] }),
  };
}

/** Patterns `direct` may push to: `directBranches`, else just `directBranch`. None without `direct`. */
export function directBranchPatterns(settings: EditSettings): readonly string[] {
  if (!settings.modes.includes("direct")) return [];
  if (settings.directBranches !== undefined) return settings.directBranches;
  return settings.directBranch === undefined ? [] : [settings.directBranch];
}

/** True when `direct` may push to `branch`. The default and protected branches are not special: list them to allow them. */
export function mayPushDirect(settings: EditSettings, branch: string): boolean {
  return matchesBranchPatterns(branch, directBranchPatterns(settings));
}

export function resetEditConfig(): void {
  active = disabledEditSettings();
}

export function bootEditConfig(env: NodeJS.ProcessEnv): void {
  if (env.VITEST === "true") {
    active = disabledEditSettings();
    return;
  }
  active = loadEditConfig(env);
}

/** Edit settings stored on a repository entry. The bot token path never leaves the server. */
export function editSettingsForRepo(edit: {
  modes: readonly EditMode[];
  baseBranch?: string;
  directBranch?: string;
  directBranches?: readonly string[];
  botTokenFile?: string;
}): EditSettings {
  const modes = [...edit.modes];
  const directBranch = modes.includes("direct") ? edit.directBranch : undefined;
  const directBranches = modes.includes("direct") ? edit.directBranches : undefined;
  return {
    enabled: modes.length > 0,
    modes,
    ...(edit.baseBranch === undefined ? {} : { baseBranch: edit.baseBranch }),
    ...(directBranch === undefined ? {} : { directBranch }),
    ...(directBranches === undefined ? {} : { directBranches: [...directBranches] }),
    botTokenConfigured: botTokenExists(edit.botTokenFile),
  };
}

export function loadEditConfig(env: NodeJS.ProcessEnv): EditSettings {
  const modes = parseModes(env.SNOBOARD_EDIT_MODES);
  const directBranch = optionalBranch(env.SNOBOARD_EDIT_DIRECT_BRANCH, "SNOBOARD_EDIT_DIRECT_BRANCH");
  if (modes.includes("direct") && directBranch === undefined) {
    invalid("SNOBOARD_EDIT_DIRECT_BRANCH is required when direct is enabled");
  }
  const baseBranch = optionalBranch(env.SNOBOARD_EDIT_BASE_BRANCH, "SNOBOARD_EDIT_BASE_BRANCH");
  const directBranches = parseBranchPatterns(env.SNOBOARD_EDIT_DIRECT_BRANCHES, "SNOBOARD_EDIT_DIRECT_BRANCHES");
  return {
    enabled: modes.length > 0,
    modes,
    ...(baseBranch === undefined ? {} : { baseBranch }),
    ...(modes.includes("direct") && directBranch !== undefined ? { directBranch } : {}),
    ...(modes.includes("direct") && directBranches !== undefined ? { directBranches } : {}),
    botTokenConfigured: botTokenExists(blank(env.SNOBOARD_EDIT_BOT_TOKEN_FILE)),
  };
}

/**
 * `githubWriteConnect`: an Access board whose GitHub OAuth client may connect a
 * write token at submit time. `needsGithubWrite` here means "a GitHub write token
 * is the only way to submit"; the API clears it once the session holds a token.
 * With a bot token too, Access users may submit via the bot or connect to commit as themselves.
 */
export function editPermissions(
  settings: EditSettings,
  actor: EditActor,
  options: { githubWriteConnect?: boolean } = {},
): EditPermissions {
  if (!settings.enabled) return { canSubmit: false, needsGithubWrite: false };
  if (actor === "github") return { canSubmit: true, needsGithubWrite: true };
  if (actor === "cloudflare-access" && options.githubWriteConnect === true) {
    return { canSubmit: true, needsGithubWrite: !settings.botTokenConfigured };
  }
  if ((actor === "password" || actor === "cloudflare-access") && settings.botTokenConfigured) {
    return { canSubmit: true, needsGithubWrite: false };
  }
  return { canSubmit: false, needsGithubWrite: false };
}

export function defaultEditMode(settings: EditSettings): "direct" | "pr" {
  return settings.modes.includes("direct") ? "direct" : "pr";
}

function parseModes(raw: string | undefined): EditMode[] {
  if (raw === undefined || raw.trim() === "") return [];
  const modes: EditMode[] = [];
  for (const part of raw.split(",")) {
    const mode = part.trim().toLowerCase();
    if (mode.length === 0) continue;
    if (!isEditMode(mode)) invalid("SNOBOARD_EDIT_MODES contains an unknown mode");
    if (!modes.includes(mode)) modes.push(mode);
  }
  return modes;
}

function isEditMode(value: string): value is EditMode {
  return MODE_VALUES.has(value as EditMode);
}

function optionalBranch(raw: string | undefined, name: string): string | undefined {
  const value = blank(raw);
  if (value === undefined) return undefined;
  return parseBranch(value, name);
}

function parseBranch(value: string, name: string): string {
  if (
    value.length === 0 ||
    value.length > 255 ||
    /[\s\\]/.test(value) ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("..") ||
    value.includes("//") ||
    value.includes("@{") ||
    value.endsWith(".lock")
  ) {
    invalid(`${name} is not a valid branch name`);
  }
  return value;
}

/**
 * Comma-separated branch globs (`main, feat/*`, or `*`). Each must be a valid branch
 * name once `*` and `?` are taken out; unset or blank means "only directBranch".
 */
export function parseBranchPatterns(raw: string | readonly string[] | undefined, name: string): string[] | undefined {
  if (raw === undefined) return undefined;
  const parts = typeof raw === "string" ? raw.split(",") : [...raw];
  const patterns: string[] = [];
  for (const part of parts) {
    const pattern = part.trim();
    if (pattern.length === 0) continue;
    if (!isBranchPattern(pattern)) invalid(`${name} contains an invalid branch pattern`);
    if (!patterns.includes(pattern)) patterns.push(pattern);
  }
  if (typeof raw === "string" && patterns.length === 0) return undefined;
  return patterns;
}

function isBranchPattern(pattern: string): boolean {
  if (pattern === "*") return true;
  // A glob is valid when the name it describes is: `*` and `?` stand for ordinary characters.
  return isValidBranchName(pattern.replaceAll("*", "x").replaceAll("?", "x"));
}

function blank(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function botTokenExists(file: string | undefined): boolean {
  if (file === undefined) return false;
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function invalid(message: string): never {
  throw new Error(`Invalid Snoboard edit environment: ${message}`);
}