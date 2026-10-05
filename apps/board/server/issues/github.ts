import { createFailure, isRecord as isObject, positiveInteger, transportFailure } from "./create-common.js";
import { IssueCreateError, type IssueProvider, type IssueRef, type IssueState } from "./provider.js";

const REPO = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const NUMBER = /^[1-9]\d*$/;
const QUALIFIED = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9]\d*)$/;

type Target = {
  owner: string;
  name: string;
  number: string;
};

function locate(ref: IssueRef, defaultRepo: string): Target | undefined {
  if (ref.provider !== "gh") return undefined;
  const qualified = QUALIFIED.exec(ref.key);
  if (qualified?.[1] && qualified[2] && qualified[3]) {
    return { owner: qualified[1], name: qualified[2], number: qualified[3] };
  }
  if (!NUMBER.test(ref.key)) return undefined;
  const repo = REPO.exec(defaultRepo.trim());
  if (!repo?.[1] || !repo[2]) return undefined;
  return { owner: repo[1], name: repo[2], number: ref.key };
}

function sameRepo(target: Target, defaultRepo: string): boolean {
  return `${target.owner}/${target.name}`.toLowerCase() === defaultRepo.trim().toLowerCase();
}

function issueUrl(target: Target): string {
  return `https://github.com/${target.owner}/${target.name}/issues/${target.number}`;
}

function githubHeaders(token: string | undefined): Headers {
  const headers = new Headers();
  headers.set("Accept", "application/vnd.github+json");
  headers.set("User-Agent", "snoboard");
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  if (token !== undefined) headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withoutToken(value: string, token: string | undefined): string {
  if (token === undefined || token.length < 8) return value;
  return value.includes(token) ? "" : value;
}

function htmlUrl(value: unknown, token: string | undefined, fallback: string): string {
  if (typeof value !== "string" || !value.startsWith("https://github.com/")) return fallback;
  if (token !== undefined && token.length >= 8 && value.includes(token)) return fallback;
  return value;
}

function toState(ref: IssueRef, body: unknown, token: string | undefined, fallback: string): IssueState {
  if (!isRecord(body)) return { raw: ref.raw, title: "", state: "unknown", url: fallback };
  const state = body.state === "open" || body.state === "closed" ? body.state : "unknown";
  const title = typeof body.title === "string" ? withoutToken(body.title, token) : "";
  const updatedAt = typeof body.updated_at === "string" ? withoutToken(body.updated_at, token) : "";
  return {
    raw: ref.raw,
    title,
    state,
    url: htmlUrl(body.html_url, token, fallback),
    ...(updatedAt.length > 0 ? { updatedAt } : {}),
  };
}

function unknown(ref: IssueRef, url: string): IssueState {
  return { raw: ref.raw, title: "", state: "unknown", url };
}

export function createGithubIssueProvider(input: {
  defaultRepo: string;
  token?: string;
  fetchImpl?: typeof fetch;
}): IssueProvider {
  const fetchImpl = input.fetchImpl ?? fetch;
  const token = input.token !== undefined && input.token.length > 0 ? input.token : undefined;

  return {
    id: "gh",
    parseRef(ref) {
      return locate(ref, input.defaultRepo) !== undefined;
    },
    linkFor(ref) {
      const target = locate(ref, input.defaultRepo);
      return target === undefined ? "" : issueUrl(target);
    },
    async fetchStates(refs, signal) {
      const map = new Map<string, IssueState>();
      await Promise.all(
        refs.map(async (ref) => {
          const target = locate(ref, input.defaultRepo);
          const fallback = target === undefined ? "" : issueUrl(target);
          if (target === undefined || signal.aborted) {
            map.set(ref.raw, unknown(ref, fallback));
            return;
          }
          try {
            const response = await fetchImpl(
              `https://api.github.com/repos/${target.owner}/${target.name}/issues/${target.number}`,
              {
                method: "GET",
                // The token is scoped to the board's repo; other repos are read anonymously.
                headers: githubHeaders(sameRepo(target, input.defaultRepo) ? token : undefined),
                redirect: "error",
                signal,
              },
            );
            if (!response.ok) {
              map.set(ref.raw, unknown(ref, fallback));
              return;
            }
            const body: unknown = await response.json();
            map.set(ref.raw, toState(ref, body, token, fallback));
          } catch {
            map.set(ref.raw, unknown(ref, fallback));
          }
        }),
      );
      return map;
    },
    // The signed-in person's own write token, never the board's read token.
    async createIssue(issue, credential, signal) {
      const repo = REPO.exec(input.defaultRepo.trim());
      if (!repo?.[1] || !repo[2]) throw new IssueCreateError("not_found", "no GitHub repository is configured");
      const userToken = credential.token !== undefined && credential.token.length > 0 ? credential.token : undefined;
      if (userToken === undefined) throw new IssueCreateError("auth", "connect GitHub write access first");
      const tokens = [userToken, token];
      const headers = githubHeaders(userToken);
      headers.set("Content-Type", "application/json");
      let response: Response;
      try {
        response = await fetchImpl(`https://api.github.com/repos/${repo[1]}/${repo[2]}/issues`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: issue.title,
            body: issue.body,
            ...(issue.labels !== undefined && issue.labels.length > 0 ? { labels: issue.labels } : {}),
          }),
          redirect: "error",
          signal,
        });
      } catch (error) {
        throw transportFailure("GitHub", error);
      }
      if (!response.ok) {
        throw await createFailure("GitHub", response, tokens, "GitHub refused: the token cannot create issues in this repository");
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new IssueCreateError("upstream", "GitHub answered without an issue");
      }
      const number = isObject(body) ? positiveInteger(body.number) : undefined;
      if (number === undefined || !isObject(body)) throw new IssueCreateError("upstream", "GitHub answered without an issue number");
      const target = { owner: repo[1], name: repo[2], number: String(number) };
      return { ref: `gh#${number}`, url: htmlUrl(body.html_url, userToken, issueUrl(target)) };
    },
  };
}
