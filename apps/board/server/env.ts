import { z } from "zod";

function blankToUndefined(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

const runtimeFields = {
  SNOBOARD_DATA_DIR: z.string().min(1).default("/tmp/snoboard"),
  SNOBOARD_REFRESH_SECONDS: z.preprocess(
    (value) => (value === undefined || value === "" ? undefined : value),
    z.coerce.number().int().positive().default(120),
  ),
};

export const BoardEnvSchema = z.object({
  SNOBOARD_REPO_URL: z.string().min(1),
  ...runtimeFields,
  SNOBOARD_SSH_KEY_FILE: z.preprocess(blankToUndefined, z.string().min(1).optional()),
  SNOBOARD_GIT_TOKEN_FILE: z.preprocess(blankToUndefined, z.string().min(1).optional()),
  SNOBOARD_CONFIG_PATH: z.preprocess(blankToUndefined, z.string().min(1).optional()),
});

export type BoardEnv = {
  repoUrl: string;
  dataDir: string;
  refreshSeconds: number;
  sshKeyFile?: string;
  gitTokenFile?: string;
  configPath?: string;
};

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "env";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

export function loadSyncSettings(source: NodeJS.ProcessEnv): { dataDir: string; refreshSeconds: number } {
  const parsed = z
    .object(runtimeFields)
    .safeParse({
      SNOBOARD_DATA_DIR: source.SNOBOARD_DATA_DIR,
      SNOBOARD_REFRESH_SECONDS: source.SNOBOARD_REFRESH_SECONDS,
    });
  if (!parsed.success) {
    throw new Error(`Invalid Snoboard environment: ${formatIssues(parsed.error)}`);
  }
  return {
    dataDir: parsed.data.SNOBOARD_DATA_DIR.trim(),
    refreshSeconds: parsed.data.SNOBOARD_REFRESH_SECONDS,
  };
}

export function loadBoardEnv(source: NodeJS.ProcessEnv): BoardEnv {
  const parsed = BoardEnvSchema.safeParse({
    SNOBOARD_REPO_URL: source.SNOBOARD_REPO_URL,
    SNOBOARD_DATA_DIR: source.SNOBOARD_DATA_DIR,
    SNOBOARD_REFRESH_SECONDS: source.SNOBOARD_REFRESH_SECONDS,
    SNOBOARD_SSH_KEY_FILE: source.SNOBOARD_SSH_KEY_FILE,
    SNOBOARD_GIT_TOKEN_FILE: source.SNOBOARD_GIT_TOKEN_FILE,
    SNOBOARD_CONFIG_PATH: source.SNOBOARD_CONFIG_PATH,
  });
  if (!parsed.success) {
    throw new Error(`Invalid Snoboard environment: ${formatIssues(parsed.error)}`);
  }
  const env = parsed.data;
  return {
    repoUrl: env.SNOBOARD_REPO_URL.trim(),
    dataDir: env.SNOBOARD_DATA_DIR.trim(),
    refreshSeconds: env.SNOBOARD_REFRESH_SECONDS,
    sshKeyFile: env.SNOBOARD_SSH_KEY_FILE,
    gitTokenFile: env.SNOBOARD_GIT_TOKEN_FILE,
    configPath: env.SNOBOARD_CONFIG_PATH,
  };
}
