import { readFileSync } from "node:fs";
import type { IssueProvider, IssueRef, IssueState } from "./provider.js";
import { vikunjaBase } from "./vikunja.js";

const REPO = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const NUMBER = /^[1-9]\d*$/;
const QUALIFIED = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9]\d*)$/;

type Target = {
  owner: string;
  name: string;
  number: string;
};

/** `owner/name` when valid, else undefined. */
export function forgejoRepo(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return REPO.test(trimmed) ? trimmed : undefined;
}

/** Same rules as Vikunja: https (http only for localhost), no credentials, query or hash. */
export const forgejoBase = vikunjaBase;

function readToken(tokenFile: string | undefined): string | undefined {
  if (tokenFile === undefined) return undefined;
  try {
    const token = readFileSync(tokenFile, "utf8").trim();
    if (token.length === 0 || token.includes("\n") || token.includes("\r")) return undefined;
    return token;
  } catch {
    return undefined;
  }
}

function locate(ref: IssueRef, defaultRepo: string | undefined): Target | undefined {
  if (ref.provider !== "fj") return undefined;
  const qualified = QUALIFIED.exec(ref.key);
  if (qualified?.[1] && qualified[2] && qualified[3]) {
    return { owner: qualified[1], name: qualified[2], number: qualified[3] };
  }
  if (!NUMBER.test(ref.key) || defaultRepo === undefined) return undefined;
  const repo = REPO.exec(defaultRepo);
  if (!repo?.[1] || !repo[2]) return undefined;
  return { owner: repo[1], name: repo[2], number: ref.key };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withoutToken(value: string, token: string | undefined): string {
  if (token === undefined || token.length < 8) return value;
  return value.includes(token) ? "" : value;
}

function headers(token: string): Headers {
  const result = new Headers();
  result.set("Accept", "application/json");
  result.set("Authorization", `token ${token}`);
  return result;
}

function unknown(ref: IssueRef, url: string): IssueState {
  return { raw: ref.raw, title: "", state: "unknown", url };
}

export function createForgejoProvider(input: {
  baseUrl: string;
  /** `owner/name` that `fj#n` means. */
  repo: string;
  /** Optional. Without a readable token the provider only builds links and never calls Forgejo. */
  tokenFile?: string;
  fetchImpl?: typeof fetch;
}): IssueProvider {
  const fetchImpl = input.fetchImpl ?? fetch;
  const base = forgejoBase(input.baseUrl.trim());
  const defaultRepo = forgejoRepo(input.repo);
  const token = readToken(input.tokenFile);

  function issueUrl(target: Target): string {
    return `${base ?? ""}/${target.owner}/${target.name}/issues/${target.number}`;
  }

  function htmlUrl(value: unknown, fallback: string): string {
    if (base === undefined || typeof value !== "string" || !value.startsWith(`${base}/`)) return fallback;
    if (token !== undefined && token.length >= 8 && value.includes(token)) return fallback;
    return value;
  }

  function toState(ref: IssueRef, body: unknown, fallback: string): IssueState {
    if (!isRecord(body)) return unknown(ref, fallback);
    const state = body.state === "open" || body.state === "closed" ? body.state : "unknown";
    const title = typeof body.title === "string" ? withoutToken(body.title, token) : "";
    const updatedAt = typeof body.updated_at === "string" ? withoutToken(body.updated_at, token) : "";
    return {
      raw: ref.raw,
      title,
      state,
      url: htmlUrl(body.html_url, fallback),
      ...(updatedAt.length > 0 ? { updatedAt } : {}),
    };
  }

  return {
    id: "fj",
    parseRef(ref) {
      return base !== undefined && locate(ref, defaultRepo) !== undefined;
    },
    linkFor(ref) {
      const target = locate(ref, defaultRepo);
      return base === undefined || target === undefined ? "" : issueUrl(target);
    },
    async fetchStates(refs, signal) {
      const map = new Map<string, IssueState>();
      await Promise.all(
        refs.map(async (ref) => {
          const target = locate(ref, defaultRepo);
          const fallback = base === undefined || target === undefined ? "" : issueUrl(target);
          if (base === undefined || target === undefined || token === undefined || signal.aborted) {
            map.set(ref.raw, unknown(ref, fallback));
            return;
          }
          try {
            // Pull requests share the issue index, so /issues/{n} also answers for /pulls/{n}.
            const response = await fetchImpl(
              `${base}/api/v1/repos/${target.owner}/${target.name}/issues/${target.number}`,
              { method: "GET", headers: headers(token), redirect: "error", signal },
            );
            if (!response.ok) {
              map.set(ref.raw, unknown(ref, fallback));
              return;
            }
            const body: unknown = await response.json();
            map.set(ref.raw, toState(ref, body, fallback));
          } catch {
            map.set(ref.raw, unknown(ref, fallback));
          }
        }),
      );
      return map;
    },
  };
}
