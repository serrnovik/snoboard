import { getPublicAuthView, type PublicAuthView } from "../server/auth/env.js";
import { boardVersion } from "../server/version.js";

export type { PublicAuthView };

export type PageData = PublicAuthView & { version: string };

export function data(): PageData {
  return { ...getPublicAuthView(), version: boardVersion() };
}
