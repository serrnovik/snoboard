import type { Context } from "hono";
import { Hono } from "hono";
import { blockedChain } from "snoboard";
import { authMiddleware, type BoardEnv } from "./auth/middleware.js";
import { enrichPulls, githubTokenFromEnv } from "./forge/github.js";
import { requestRefresh } from "./repo-sync.js";
import { getConfig, getSnapshot, getStatus } from "./store.js";

const REFRESH_WINDOW_MS = 30_000;

const lastRefreshAt = new Map<string, number>();

export function resetRefreshLimits(): void {
  lastRefreshAt.clear();
}

function refreshSubject(c: Context<BoardEnv>): string {
  const session = c.get("session");
  if (session === undefined || session.sub.length === 0) return "anonymous";
  return session.sub;
}

function allowRefresh(session: string, now: number): boolean {
  const previous = lastRefreshAt.get(session);
  if (previous !== undefined && now - previous < REFRESH_WINDOW_MS) {
    return false;
  }
  lastRefreshAt.set(session, now);
  return true;
}

export const api = new Hono<BoardEnv>();

api.use("*", authMiddleware);
api.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});

api.get("/board", (c) => {
  const snapshot = getSnapshot();
  const config = getConfig();
  if (snapshot === null || config === null) {
    return c.json({ error: "snapshot not ready" }, 503);
  }
  return c.json({
    status: getStatus(),
    config: {
      statuses: config.statuses,
      priorities: config.priorities,
      doneStatuses: config.doneStatuses,
    },
    items: snapshot.items,
    legacy: snapshot.legacy,
    errors: snapshot.errors,
    refs: snapshot.refs,
  });
});

api.get("/initiatives/:id", async (c) => {
  const snapshot = getSnapshot();
  if (snapshot === null) {
    return c.json({ error: "snapshot not ready" }, 503);
  }
  const id = c.req.param("id");
  const item = snapshot.items.find((entry) => entry.id === id);
  if (item === undefined) {
    return c.json({ error: "not found" }, 404);
  }
  const dependents = dependentIds(snapshot.graph.edges, id);
  const config = getConfig();
  const pullNumbers = (item.phases ?? []).flatMap((phase) => (phase.pr === undefined ? [] : [phase.pr]));
  const prs = await loadPulls(config, pullNumbers);
  return c.json({
    ...item,
    blockedChain: blockedChain(snapshot.graph, id),
    dependents,
    ...(config === null ? {} : { forge: config.forge }),
    ...(prs === undefined ? {} : { prs }),
  });
});

function initiativeId(nodeId: string): string {
  const hash = nodeId.indexOf("#");
  if (hash === -1) return nodeId;
  return nodeId.slice(0, hash);
}

function dependentIds(edges: readonly { from: string; to: string }[], id: string): string[] {
  const prefix = `${id}#`;
  const dependents = new Set<string>();
  for (const edge of edges) {
    if (edge.from !== id && !edge.from.startsWith(prefix)) continue;
    const target = initiativeId(edge.to);
    if (target === id) continue;
    dependents.add(target);
  }
  return [...dependents].sort((left, right) => left.localeCompare(right));
}

async function loadPulls(
  config: ReturnType<typeof getConfig>,
  pullNumbers: readonly number[],
): Promise<Awaited<ReturnType<typeof enrichPulls>>> {
  if (config === null) return undefined;
  try {
    return await enrichPulls({
      repo: config.forge.repo,
      token: githubTokenFromEnv(),
      pullNumbers,
    });
  } catch {
    return undefined;
  }
}

api.post("/refresh", (c) => {
  const session = refreshSubject(c);
  if (!allowRefresh(session, Date.now())) {
    return c.json({ error: "refresh rate limited" }, 429);
  }
  void requestRefresh();
  return c.json({ accepted: true }, 202);
});
