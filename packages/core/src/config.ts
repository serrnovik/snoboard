import { parse } from "yaml";
import { z } from "zod";

const statusList = [
  "idea",
  "planned",
  "in-progress",
  "review",
  "done",
  "parked",
  "dropped",
] as const;

const priorityList = ["p0", "p1", "p2", "p3"] as const;

export const DEFAULT_FORGE_FILE_URL = "https://github.com/{repo}/blob/{ref}/{path}";
export const DEFAULT_FORGE_PR_URL = "https://github.com/{repo}/pull/{pr}";

export const ForgeSchema = z.object({
  type: z.literal("github").default("github"),
  repo: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "repo must look like owner/name")
    .default("owner/name"),
  fileUrl: z.string().min(1).default(DEFAULT_FORGE_FILE_URL),
  prUrl: z.string().min(1).default(DEFAULT_FORGE_PR_URL),
});

export type ForgeConfig = z.infer<typeof ForgeSchema>;

/** Display settings for one project folder. `icon` is checked by `validate` (a bad value is a warning). */
export const ProjectDisplaySchema = z.object({
  icon: z.unknown().optional(),
  name: z.string().min(1).max(80).optional(),
});

/** Display settings for one label. `icon` and `color` are checked by `validate` (bad values are warnings). */
export const LabelDisplaySchema = z.object({
  icon: z.unknown().optional(),
  color: z.unknown().optional(),
});

export type ProjectDisplay = z.infer<typeof ProjectDisplaySchema>;
export type LabelDisplay = z.infer<typeof LabelDisplaySchema>;

const defaultForge = {
  type: "github",
  repo: "owner/name",
  fileUrl: DEFAULT_FORGE_FILE_URL,
  prUrl: DEFAULT_FORGE_PR_URL,
} as const satisfies ForgeConfig;

export const ConfigSchema = z
  .object({
    root: z.string().min(1).default("initiatives"),
    file: z.string().min(1).default("initiative.md"),
    idFormat: z.string().min(1).default("{project}-{number}"),
    defaultBranch: z.string().min(1).default("main"),
    branchPatterns: z.array(z.string().min(1)).default(() => ["initiative/*"]),
    statuses: z.array(z.string().min(1)).min(1).default(() => [...statusList]),
    doneStatuses: z.array(z.string().min(1)).min(1).default(() => ["done"]),
    priorities: z.array(z.string().min(1)).min(1).default(() => [...priorityList]),
    staleAfterDays: z.number().int().nonnegative().default(30),
    // Parking-lot folders such as 999-backlog that next-number must skip.
    reservedNumbers: z.array(z.number().int().nonnegative()).default(() => []),
    forge: ForgeSchema.default(defaultForge),
    projects: z.record(z.string().min(1), ProjectDisplaySchema).default(() => ({})),
    labels: z.record(z.string().min(1), LabelDisplaySchema).default(() => ({})),
  })
  .superRefine((value, ctx) => {
    const missing = value.doneStatuses.filter((status) => !value.statuses.includes(status));
    if (missing.length === 0) return;
    ctx.addIssue({
      code: "custom",
      path: ["doneStatuses"],
      message: `doneStatuses ${missing.map((status) => `"${status}"`).join(", ")} must each be listed in statuses`,
    });
  });

export type Config = z.infer<typeof ConfigSchema>;

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "config";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

function cloneConfig(config: Config): Config {
  return {
    ...config,
    branchPatterns: [...config.branchPatterns],
    statuses: [...config.statuses],
    doneStatuses: [...config.doneStatuses],
    priorities: [...config.priorities],
    reservedNumbers: [...config.reservedNumbers],
    forge: { ...config.forge },
    projects: Object.fromEntries(Object.entries(config.projects).map(([key, value]) => [key, { ...value }])),
    labels: Object.fromEntries(Object.entries(config.labels).map(([key, value]) => [key, { ...value }])),
  };
}

export function loadConfig(yamlText?: string): Config {
  if (yamlText === undefined || yamlText.trim() === "") {
    return cloneConfig(ConfigSchema.parse({}));
  }

  let raw: unknown;
  try {
    raw = parse(yamlText, { schema: "core" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid .snoboard.yml: ${message}`);
  }

  if (raw === null || raw === undefined) {
    return cloneConfig(ConfigSchema.parse({}));
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid .snoboard.yml: expected a mapping of config keys");
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid .snoboard.yml: ${formatIssues(parsed.error)}`);
  }
  return cloneConfig(parsed.data);
}