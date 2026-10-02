import { statSync } from "node:fs";

export type EditMode = "pr" | "direct";

export type EditActor = "anonymous" | "password" | "github" | "cloudflare-access";

export type EditSettings = {
  enabled: boolean;
  modes: readonly EditMode[];
  baseBranch?: string;
  directBranch?: string;
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
  return { ...active, modes: [...active.modes] };
}

export function setEditConfig(settings: EditSettings): void {
  active = { ...settings, modes: [...settings.modes] };
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
  botTokenFile?: string;
}): EditSettings {
  const modes = [...edit.modes];
  const directBranch = modes.includes("direct") ? edit.directBranch : undefined;
  return {
    enabled: modes.length > 0,
    modes,
    ...(edit.baseBranch === undefined ? {} : { baseBranch: edit.baseBranch }),
    ...(directBranch === undefined ? {} : { directBranch }),
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
  return {
    enabled: modes.length > 0,
    modes,
    ...(baseBranch === undefined ? {} : { baseBranch }),
    ...(modes.includes("direct") && directBranch !== undefined ? { directBranch } : {}),
    botTokenConfigured: botTokenExists(blank(env.SNOBOARD_EDIT_BOT_TOKEN_FILE)),
  };
}

export function editPermissions(settings: EditSettings, actor: EditActor): EditPermissions {
  if (!settings.enabled) return { canSubmit: false, needsGithubWrite: false };
  if (actor === "github") return { canSubmit: true, needsGithubWrite: true };
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