import { z } from "zod";
import type { Config } from "./config.js";

const INITIATIVE_ID = /^[a-z0-9_-]+-\d{3}$/;
const DEPENDENCY_ID = /^[a-z0-9_-]+-\d{3}(#(0|[1-9]\d*))?$/;

function requiredEnum(values: readonly string[], label: string) {
  const unique = [...new Set(values)];
  if (unique.length === 0) {
    throw new Error(`${label} must contain at least one value`);
  }
  return z.enum(unique as [string, ...string[]]);
}

export function PhaseSchema(config: Config) {
  return z.object({
    // Phase 0 is allowed: many plans start with "Phase 0 — investigation".
    id: z.number().int().nonnegative(),
    title: z.string().min(1),
    status: requiredEnum(config.statuses, "statuses"),
    pr: z.number().int().positive().optional(),
    depends_on: z.array(z.number().int().nonnegative()).optional(),
  });
}

export function InitiativeFrontmatterSchema(config: Config) {
  return z
    .object({
      id: z.string().regex(INITIATIVE_ID),
      title: z.string().min(1),
      status: requiredEnum(config.statuses, "statuses"),
      priority: requiredEnum(config.priorities, "priorities"),
      depends_on: z.array(z.string().regex(DEPENDENCY_ID)).default(() => []),
      branch: z.string().min(1).optional(),
      updated: z.iso.date(),
      labels: z.array(z.string().min(1)).optional(),
      issues: z.array(z.string()).optional(),
      // Shape only; `validate` reports bad titles and URLs so the initiative still shows.
      links: z.array(z.object({ title: z.string(), url: z.string() }).passthrough()).optional(),
      phases: z.array(PhaseSchema(config)).optional(),
      // Shape only; `validate` warns about a bad value and the board then shows no icon.
      icon: z.unknown().optional(),
    })
    .passthrough();
}

export type Phase = z.infer<ReturnType<typeof PhaseSchema>>;
export type InitiativeFrontmatter = z.infer<ReturnType<typeof InitiativeFrontmatterSchema>>;
