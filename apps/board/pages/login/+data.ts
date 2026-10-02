import { getPublicAuthView, type PublicAuthView } from "../../server/auth/env.js";
import { boardVersion } from "../../server/version.js";

export type LoginPageData = PublicAuthView & { version?: string };

export function data(): LoginPageData {
  return { ...getPublicAuthView(), version: boardVersion() };
}
