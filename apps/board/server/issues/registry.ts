import type { IssueProvider, IssueRef, IssueState } from "./provider.js";

export const ISSUE_CACHE_TTL_MS = 5 * 60 * 1000;
export const ISSUE_FETCH_TIMEOUT_MS = 10_000;
export const ISSUE_FETCH_BUDGET_MS = 15_000;
export const ISSUE_FETCH_CONCURRENCY = 4;

type CacheEntry = {
  expires: number;
  value: IssueState;
};

export type IssueRegistryOptions = {
  now?: () => number;
  timeoutMs?: number;
  budgetMs?: number;
  concurrency?: number;
  ttlMs?: number;
};

export type IssueRegistry = {
  linkFor(ref: IssueRef): string | undefined;
  fetchStates(refs: readonly IssueRef[]): Promise<Map<string, IssueState>>;
};

type ProviderGroup = {
  provider: IssueProvider;
  refs: IssueRef[];
};

function unknownState(ref: IssueRef, url: string): IssueState {
  return { raw: ref.raw, title: "", state: "unknown", url };
}

function safeLink(provider: IssueProvider, ref: IssueRef): string {
  try {
    const link = provider.linkFor(ref);
    return typeof link === "string" ? link : "";
  } catch {
    return "";
  }
}

function cacheable(ref: IssueRef, state: IssueState | undefined, fallbackUrl: string): IssueState | undefined {
  if (state === undefined) return undefined;
  if (state.state !== "open" && state.state !== "closed") return undefined;
  const title = typeof state.title === "string" ? state.title : "";
  const url = typeof state.url === "string" && state.url.length > 0 ? state.url : fallbackUrl;
  const updatedAt = typeof state.updatedAt === "string" && state.updatedAt.length > 0 ? state.updatedAt : undefined;
  return {
    raw: ref.raw,
    title,
    state: state.state,
    url,
    ...(updatedAt === undefined ? {} : { updatedAt }),
  };
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

async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  budget: AbortSignal,
  worker: (item: T) => Promise<void>,
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

export function createIssueRegistry(
  providers: readonly IssueProvider[],
  options: IssueRegistryOptions = {},
): IssueRegistry {
  const cache = new Map<string, CacheEntry>();
  const timeoutMs = options.timeoutMs ?? ISSUE_FETCH_TIMEOUT_MS;
  const budgetMs = options.budgetMs ?? ISSUE_FETCH_BUDGET_MS;
  const concurrency = options.concurrency ?? ISSUE_FETCH_CONCURRENCY;
  const ttlMs = options.ttlMs ?? ISSUE_CACHE_TTL_MS;

  function providerFor(ref: IssueRef): IssueProvider | undefined {
    return providers.find((provider) => {
      try {
        return provider.parseRef(ref);
      } catch {
        return false;
      }
    });
  }

  function linkFor(ref: IssueRef): string | undefined {
    const provider = providerFor(ref);
    if (provider === undefined) return undefined;
    const link = safeLink(provider, ref);
    return link.length > 0 ? link : undefined;
  }

  async function fetchStates(refs: readonly IssueRef[]): Promise<Map<string, IssueState>> {
    const now = options.now?.() ?? Date.now();
    const result = new Map<string, IssueState>();
    const groups: ProviderGroup[] = [];
    const seen = new Set<string>();

    for (const ref of refs) {
      if (seen.has(ref.raw)) continue;
      seen.add(ref.raw);
      const cached = cache.get(ref.raw);
      if (cached !== undefined && cached.expires > now) {
        result.set(ref.raw, { ...cached.value });
        continue;
      }
      const provider = providerFor(ref);
      if (provider === undefined) {
        result.set(ref.raw, unknownState(ref, ""));
        continue;
      }
      const existing = groups.find((group) => group.provider === provider);
      if (existing === undefined) groups.push({ provider, refs: [ref] });
      else existing.refs.push(ref);
    }

    if (groups.length > 0) {
      const budget = new AbortController();
      const budgetTimer = setTimeout(() => budget.abort(), budgetMs);
      try {
        await runPool(groups, concurrency, budget.signal, async (group) => {
          const fallback = new Map(group.refs.map((ref) => [ref.raw, safeLink(group.provider, ref)]));
          if (budget.signal.aborted) {
            for (const ref of group.refs) result.set(ref.raw, unknownState(ref, fallback.get(ref.raw) ?? ""));
            return;
          }
          const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), budget.signal]);
          try {
            const fetched = await settle(group.provider.fetchStates(group.refs, signal), signal);
            for (const ref of group.refs) {
              const url = fallback.get(ref.raw) ?? "";
              const stored = fetched instanceof Map ? cacheable(ref, fetched.get(ref.raw), url) : undefined;
              if (stored === undefined) {
                result.set(ref.raw, unknownState(ref, url));
                continue;
              }
              cache.set(ref.raw, { expires: now + ttlMs, value: stored });
              result.set(ref.raw, { ...stored });
            }
          } catch {
            for (const ref of group.refs) {
              result.set(ref.raw, unknownState(ref, fallback.get(ref.raw) ?? ""));
            }
          }
        });
      } finally {
        clearTimeout(budgetTimer);
      }
    }

    for (const group of groups) {
      for (const ref of group.refs) {
        if (!result.has(ref.raw)) result.set(ref.raw, unknownState(ref, safeLink(group.provider, ref)));
      }
    }
    return result;
  }

  return { linkFor, fetchStates };
}
