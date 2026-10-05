import { useEffect, useState } from "react";
import { redirectToLogin } from "@/features/board/sync";
import { useRepoId } from "@/features/repo/context";
import { repoApi } from "@/lib/routes";

export type EditModeName = "pr" | "direct";

export type ClientEditConfig = {
  enabled: boolean;
  canSubmit: boolean;
  needsGithubWrite: boolean;
  /** Access board where a GitHub write token can be connected at submit time. */
  githubWriteConnect?: boolean;
  /** GitHub login of the connected write token, when there is one. */
  githubLogin?: string;
  modes: EditModeName[];
  defaultMode: EditModeName;
  csrf?: string;
  directBranch?: string;
  baseBranch?: string;
  /** GitHub owner/name, for https links to commits. */
  forgeRepo?: string;
  /** Tracker link settings (no tokens): Vikunja/Forgejo sites and the repos `gh#n` / `fj#n` mean. */
  issues?: IssueLinks;
  /** Trackers this person may create issues in (`gh` uses their own GitHub token). */
  createProviders?: ("gh" | "fj" | "vikunja")[];
};

const EMPTY_CONFIG: ClientEditConfig = {
  enabled: false,
  canSubmit: false,
  needsGithubWrite: false,
  modes: [],
  defaultMode: "pr",
};

export function useEditConfig(): ClientEditConfig & { ready: boolean } {
  const repoId = useRepoId();
  const [state, setState] = useState<ClientEditConfig & { ready: boolean }>({ ready: false, ...EMPTY_CONFIG });

  useEffect(() => {
    const controller = new AbortController();
    void fetch(repoApi(repoId, "/edit-config"), { credentials: "same-origin", signal: controller.signal })
      .then(async (response) => {
        if (controller.signal.aborted) return;
        if (response.status === 401) {
          redirectToLogin();
          return;
        }
        const body: unknown = await response.json().catch(() => null);
        if (controller.signal.aborted) return;
        setState({ ready: true, ...parseEditConfig(body) });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setState({ ready: true, ...EMPTY_CONFIG });
      });
    return () => controller.abort();
  }, [repoId]);

  return state;
}

export function parseEditConfig(value: unknown): ClientEditConfig {
  if (!isRecord(value)) return { ...EMPTY_CONFIG };
  const modes = Array.isArray(value.modes)
    ? value.modes.filter((mode): mode is EditModeName => mode === "pr" || mode === "direct")
    : [];
  const defaultMode: EditModeName =
    value.defaultMode === "direct" || value.defaultMode === "pr"
      ? value.defaultMode
      : modes.includes("direct")
        ? "direct"
        : "pr";
  return {
    enabled: value.enabled === true,
    canSubmit: value.canSubmit === true,
    needsGithubWrite: value.needsGithubWrite === true,
    ...(value.githubWriteConnect === true ? { githubWriteConnect: true } : {}),
    ...(typeof value.githubLogin === "string" && /^[A-Za-z0-9-]{1,39}$/.test(value.githubLogin)
      ? { githubLogin: value.githubLogin }
      : {}),
    modes,
    defaultMode,
    ...(typeof value.csrf === "string" && value.csrf.length > 0 ? { csrf: value.csrf } : {}),
    ...(typeof value.directBranch === "string" && value.directBranch.length > 0
      ? { directBranch: value.directBranch }
      : {}),
    ...(typeof value.baseBranch === "string" && value.baseBranch.length > 0 ? { baseBranch: value.baseBranch } : {}),
    ...(typeof value.forgeRepo === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.forgeRepo)
      ? { forgeRepo: value.forgeRepo }
      : {}),
    ...(isRecord(value.issues) ? { issues: parseIssueLinks(value.issues) } : {}),
    ...(Array.isArray(value.createProviders)
      ? {
          createProviders: value.createProviders.filter(
            (entry, index, list): entry is "gh" | "fj" | "vikunja" =>
              (entry === "gh" || entry === "fj" || entry === "vikunja") && list.indexOf(entry) === index,
          ),
        }
      : {}),
  };
}

type IssueLinks = { vikunjaBaseUrl?: string; githubRepo?: string; forgejoBaseUrl?: string; forgejoRepo?: string };

function parseIssueLinks(value: Record<string, unknown>): IssueLinks {
  const base = typeof value.vikunjaBaseUrl === "string" ? value.vikunjaBaseUrl : "";
  const repo = typeof value.githubRepo === "string" ? value.githubRepo : "";
  const fjBase = typeof value.forgejoBaseUrl === "string" ? value.forgejoBaseUrl : "";
  const fjRepo = typeof value.forgejoRepo === "string" ? value.forgejoRepo : "";
  return {
    ...(/^https?:\/\/[^\s]+$/.test(base) ? { vikunjaBaseUrl: base } : {}),
    ...(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ? { githubRepo: repo } : {}),
    ...(/^https?:\/\/[^\s]+$/.test(fjBase) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fjRepo)
      ? { forgejoBaseUrl: fjBase, forgejoRepo: fjRepo }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
