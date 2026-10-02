import { VERSION } from "snoboard/browser";
import { useData } from "vike-react/useData";

/** Deployed version from page data (`SNOBOARD_VERSION`), else the bundled package version. */
export function useAppVersion(): string {
  let data: unknown;
  try {
    data = useData<unknown>();
  } catch {
    data = undefined;
  }
  if (typeof data === "object" && data !== null) {
    const version = (data as { version?: unknown }).version;
    if (typeof version === "string" && version.length > 0) return version;
  }
  return VERSION;
}

export function AppVersion() {
  return <span data-testid="app-version">Snoboard {useAppVersion()}</span>;
}
