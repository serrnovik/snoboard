import { readFileSync } from "node:fs";

export type PullEnrichment = {
  state: string;
  merged: boolean;
  checks: string | null;
};

const CACHE_TTL_MS = 5 * 60 * 1000;
export const GITHUB_FETCH_TIMEOUT_MS = 10_000;
export const GITHUB_ENRICH_BUDGET_MS = 15_000;
export const GITHUB_ENRICH_CONCURRENCY = 4;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_PATTERN = /^[a-f0-9]{7,64}$/i;

type CacheEntry = {
  expires: number;
  value: PullEnrichment;
};

const cache = new Map<string, CacheEntry>();

export function resetForgeCache(): void {
  cache.clear();
}

export function githubTokenFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const filePath = env.SNOBOARD_GITHUB_TOKEN_FILE?.trim();
  if (filePath === undefined || filePath.length === 0) return undefined;
  try {
    const token = readFileSync(filePath, "utf8").trim();
    if (token.length === 0 || token.includes("\n") || token.includes("\r")) return undefined;
    return token;
  } catch {
    return undefined;
  }
}

export async function enrichPulls(input: {
  repo: string;
  token: string | undefined;
  pullNumbers: readonly number[];
  fetchImpl?: typeof fetch;
  now?: number;
  fetchTimeoutMs?: number;
  budgetMs?: number;
  concurrency?: number;
}): Promise<Record<string, PullEnrichment> | undefined> {
  if (input.token === undefined || input.token.length === 0) return undefined;
  if (!REPO_PATTERN.test(input.repo)) return undefined;
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now();
  const fetchTimeoutMs = input.fetchTimeoutMs ?? GITHUB_FETCH_TIMEOUT_MS;
  const budgetMs = input.budgetMs ?? GITHUB_ENRICH_BUDGET_MS;
  const concurrency = input.concurrency ?? GITHUB_ENRICH_CONCURRENCY;
  const result: Record<string, PullEnrichment> = {};
  const numbers = [...new Set(input.pullNumbers)].filter((number) => Number.isInteger(number) && number > 0);
  const pending: number[] = [];
  for (const number of numbers) {
    const key = `${input.repo}#${number}`;
    const cached = cache.get(key);
    if (cached !== undefined && cached.expires > now) {
      result[String(number)] = cached.value;
      continue;
    }
    pending.push(number);
  }
  if (pending.length === 0) return result;
  const budget = new AbortController();
  const budgetTimer = setTimeout(() => budget.abort(), budgetMs);
  try {
    await runPool(pending, concurrency, budget.signal, async (number) => {
      const key = `${input.repo}#${number}`;
      try {
        const value = await fetchPull(fetchImpl, input.repo, input.token ?? "", number, fetchTimeoutMs, budget.signal);
        if (value === undefined) return;
        cache.set(key, { expires: now + CACHE_TTL_MS, value });
        result[String(number)] = value;
      } catch {
        return;
      }
    });
  } finally {
    clearTimeout(budgetTimer);
  }
  return result;
}

function githubHeaders(token: string): Headers {
  const headers = new Headers();
  headers.set("Accept", "application/vnd.github+json");
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("User-Agent", "snoboard");
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  return headers;
}

async function runPool(
  items: readonly number[],
  concurrency: number,
  budget: AbortSignal,
  worker: (item: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0 || concurrency <= 0) return;
  const queue = [...items];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      if (budget.aborted) return;
      const item = queue.shift();
      if (item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(workers);
}

async function fetchPull(
  fetchImpl: typeof fetch,
  repo: string,
  token: string,
  number: number,
  timeoutMs: number,
  budget: AbortSignal,
): Promise<PullEnrichment | undefined> {
  const pullResponse = await githubFetch(
    fetchImpl,
    `https://api.github.com/repos/${repo}/pulls/${number}`,
    token,
    timeoutMs,
    budget,
  );
  if (pullResponse === undefined || !pullResponse.ok) return undefined;
  const pull: unknown = await pullResponse.json();
  if (!isRecord(pull)) return undefined;
  const state = typeof pull.state === "string" ? pull.state : "unknown";
  const merged = pull.merged === true;
  const sha = isRecord(pull.head) && typeof pull.head.sha === "string" ? pull.head.sha : undefined;
  let checks: string | null = null;
  if (sha !== undefined && SHA_PATTERN.test(sha)) {
    const statusResponse = await githubFetch(
      fetchImpl,
      `https://api.github.com/repos/${repo}/commits/${sha}/status`,
      token,
      timeoutMs,
      budget,
    );
    if (statusResponse !== undefined && statusResponse.ok) {
      const status: unknown = await statusResponse.json();
      if (isRecord(status) && typeof status.state === "string") checks = status.state;
    }
  }
  return { state, merged, checks };
}

async function githubFetch(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  timeoutMs: number,
  budget: AbortSignal,
): Promise<Response | undefined> {
  if (budget.aborted) return undefined;
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), budget]);
  try {
    const response = await settle(fetchImpl(url, {
      headers: githubHeaders(token),
      redirect: "error",
      signal,
    }), signal);
    if (!response.ok) return undefined;
    return response;
  } catch {
    return undefined;
  }
}

function settle<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
