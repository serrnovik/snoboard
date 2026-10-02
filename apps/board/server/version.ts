import { VERSION } from "snoboard";

const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

/** Deployed version: `SNOBOARD_VERSION` (set from the image tag by the chart), else the package version. */
export function boardVersion(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.SNOBOARD_VERSION?.trim();
  return value !== undefined && SAFE_VERSION.test(value) ? value : VERSION;
}
