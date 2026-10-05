import { readFileSync } from "node:fs";
import { createFailure, positiveInteger, snoboardFooter, transportFailure } from "./create-common.js";
import { IssueCreateError, type CreatedIssue, type IssueProject, type IssueProvider, type IssueRef, type IssueState, type NewIssue } from "./provider.js";

const TASK_ID = /^[1-9]\d*$/;

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

/** Normalized site URL, or undefined unless https (http only for localhost) without credentials, query or hash. */
export function vikunjaBase(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return undefined;
  const localhost = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && localhost)) return undefined;
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path === "/" ? "" : path}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withoutToken(value: string, token: string | undefined): string {
  if (token === undefined || token.length < 8) return value;
  return value.includes(token) ? "" : value;
}

function taskUrl(base: string, id: string): string {
  return `${base}/tasks/${id}`;
}

function fromTask(raw: string, body: unknown, token: string | undefined, url: string): IssueState | undefined {
  if (!isRecord(body)) return undefined;
  const looksLikeTask =
    typeof body.title === "string" || typeof body.done === "boolean" || typeof body.id === "number";
  if (!looksLikeTask) return undefined;
  const title = typeof body.title === "string" ? withoutToken(body.title, token) : "";
  const updatedAt = typeof body.updated === "string" ? withoutToken(body.updated, token) : "";
  return {
    raw,
    title,
    state: body.done === true ? "closed" : "open",
    url,
    ...(updatedAt.length > 0 ? { updatedAt } : {}),
  };
}

function unknown(raw: string, url: string): IssueState {
  return { raw, title: "", state: "unknown", url };
}

function headers(token: string): Headers {
  const result = new Headers();
  result.set("Accept", "application/json");
  result.set("Authorization", `Bearer ${token}`);
  return result;
}

export function createVikunjaProvider(input: {
  baseUrl: string;
  /** Optional. Without a readable token the provider only builds links and never calls Vikunja. */
  tokenFile?: string;
  /** Project that new tasks go to. Without it the provider cannot create tasks. */
  projectId?: number;
  /** Initiative project -> Vikunja project. Also enables creation without `projectId`. */
  projectMap?: Record<string, number>;
  fetchImpl?: typeof fetch;
}): IssueProvider {
  const fetchImpl = input.fetchImpl ?? fetch;
  const base = vikunjaBase(input.baseUrl.trim());
  const token = readToken(input.tokenFile);

  async function getJson(url: string, signal: AbortSignal): Promise<unknown | undefined> {
    if (base === undefined || token === undefined) return undefined;
    const response = await fetchImpl(url, {
      method: "GET",
      headers: headers(token),
      redirect: "error",
      signal,
    });
    if (!response.ok) return undefined;
    return response.json() as Promise<unknown>;
  }

  const projectId =
    input.projectId !== undefined && Number.isInteger(input.projectId) && input.projectId > 0 ? input.projectId : undefined;

  const mapped = Object.values(input.projectMap ?? {}).some((id) => Number.isInteger(id) && id > 0);
  const canCreate = base !== undefined && token !== undefined && (projectId !== undefined || mapped);

  async function listProjects(signal: AbortSignal): Promise<IssueProject[]> {
    if (base === undefined || token === undefined) return [];
    let response: Response;
    try {
      response = await fetchImpl(`${base}/api/v1/projects?per_page=200`, {
        method: "GET",
        headers: headers(token),
        redirect: "error",
        signal,
      });
    } catch (error) {
      throw transportFailure("Vikunja", error);
    }
    if (!response.ok) throw await createFailure("Vikunja", response, [token], "Vikunja token cannot list projects");
    const body: unknown = await response.json().catch(() => undefined);
    if (!Array.isArray(body)) return [];
    const projects: IssueProject[] = [];
    for (const item of body) {
      if (projects.length >= 200) break;
      if (!isRecord(item)) continue;
      const id = positiveInteger(item.id);
      if (id === undefined || item.is_archived === true) continue;
      const title = typeof item.title === "string" ? withoutToken(item.title, token).slice(0, 200) : "";
      projects.push({ id, title: title.length > 0 ? title : `Project ${id}` });
    }
    return projects;
  }

  async function createIssue(issue: NewIssue, _credential: unknown, signal: AbortSignal): Promise<CreatedIssue> {
    const target = issue.projectId ?? projectId;
    if (base === undefined || token === undefined || target === undefined) {
      throw new IssueCreateError("not_found", "Vikunja task creation is not configured");
    }
    const requestHeaders = headers(token);
    requestHeaders.set("Content-Type", "application/json");
    let response: Response;
    try {
      response = await fetchImpl(`${base}/api/v1/projects/${target}/tasks`, {
        method: "PUT",
        headers: requestHeaders,
        body: JSON.stringify({
          title: issue.title,
          description: snoboardFooter(issue.body, issue.createdBy, issue.initiativeId),
        }),
        redirect: "error",
        signal,
      });
    } catch (error) {
      throw transportFailure("Vikunja", error);
    }
    if (!response.ok) {
      throw await createFailure("Vikunja", response, [token], "Vikunja token cannot create tasks in this project");
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new IssueCreateError("upstream", "Vikunja answered without a task");
    }
    const id = isRecord(body) ? positiveInteger(body.id) : undefined;
    if (id === undefined) throw new IssueCreateError("upstream", "Vikunja answered without a task id");
    return { ref: `vj:${id}`, url: taskUrl(base, String(id)) };
  }

  return {
    id: "vikunja",
    ...(canCreate ? { createIssue, listProjects } : {}),
    parseRef(ref) {
      return ref.provider === "vikunja" && TASK_ID.test(ref.key);
    },
    linkFor(ref) {
      if (base === undefined || !TASK_ID.test(ref.key)) return "";
      return taskUrl(base, ref.key);
    },
    async fetchStates(refs, signal) {
      const map = new Map<string, IssueState>();
      await Promise.all(
        refs.map(async (ref) => {
          const url = base !== undefined && TASK_ID.test(ref.key) ? taskUrl(base, ref.key) : "";
          if (base === undefined || token === undefined || !TASK_ID.test(ref.key) || signal.aborted) {
            map.set(ref.raw, unknown(ref.raw, url));
            return;
          }
          try {
            const response = await fetchImpl(`${base}/api/v1/tasks/${ref.key}`, {
              method: "GET",
              headers: headers(token),
              redirect: "error",
              signal,
            });
            if (!response.ok) {
              map.set(ref.raw, unknown(ref.raw, url));
              return;
            }
            const body: unknown = await response.json();
            map.set(ref.raw, fromTask(ref.raw, body, token, url) ?? unknown(ref.raw, url));
          } catch {
            map.set(ref.raw, unknown(ref.raw, url));
          }
        }),
      );
      return map;
    },
    async search(query, signal) {
      if (base === undefined || token === undefined || signal.aborted) return [];
      try {
        const body = await getJson(
          `${base}/api/v1/tasks/all?s=${encodeURIComponent(query)}&per_page=10`,
          signal,
        );
        if (!Array.isArray(body)) return [];
        const found: IssueState[] = [];
        for (const item of body) {
          if (found.length >= 10) break;
          if (!isRecord(item) || typeof item.id !== "number" || !Number.isInteger(item.id) || item.id < 1) continue;
          const id = String(item.id);
          const task = fromTask(`vj:${id}`, item, token, taskUrl(base, id));
          if (task !== undefined) found.push(task);
        }
        return found;
      } catch {
        return [];
      }
    },
  };
}
