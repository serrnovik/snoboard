import { useSyncExternalStore } from "react";
import { diffBaskets, EditSchema, type Edit } from "snoboard/browser";
import { readSavedBasket, replaceSavedBasket, setBasketSyncHooks } from "@/features/basket/store";

/**
 * Browser side of the agent bridge: the bridge config, the proposal inbox, the live event stream
 * (`GET /api/events`) and the server-side basket sync. Everything is a no-op when the server has
 * the bridge off (`GET /api/agent/config` answers `{ enabled: false }`).
 */

export type AgentConfig =
  | { enabled: false }
  | { enabled: true; available: false; reason: string }
  | { enabled: true; available: true; user: { display: string }; mcpUrl?: string; tools: string[]; csrf: string };

export type ProposalStatus = "pending" | "accepted" | "rejected";

export type Proposal = {
  id: string;
  repo: string;
  branch: string;
  source: string;
  note: string;
  edits: Edit[];
  status: ProposalStatus;
  created: string;
  decided: string | null;
};

type State = { config: AgentConfig | null; proposals: Proposal[]; live: boolean };

const INITIAL: State = { config: null, proposals: [], live: false };
let state: State = INITIAL;
const listeners = new Set<() => void>();
const snapshotListeners = new Set<(repo: string, ref: string | null) => void>();

function setState(next: Partial<State>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAgentBridge(): State {
  return useSyncExternalStore(subscribe, () => state, () => INITIAL);
}

export function agentState(): State {
  return state;
}

/** Called when the server reports a new snapshot for `repo` (`ref` null: the merged board). */
export function onBoardSnapshot(listener: (repo: string, ref: string | null) => void): () => void {
  snapshotListeners.add(listener);
  return () => snapshotListeners.delete(listener);
}

function csrf(): string | undefined {
  return state.config?.enabled === true && state.config.available ? state.config.csrf : undefined;
}

async function json<T>(input: string, init?: RequestInit): Promise<{ ok: true; body: T } | { ok: false; status: number; error: string }> {
  try {
    const response = await fetch(input, {
      credentials: "same-origin",
      ...init,
      headers: { accept: "application/json", ...(init?.body === undefined ? {} : { "content-type": "application/json" }), ...init?.headers },
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = isRecord(body) && typeof body.error === "string" ? body.error : `request failed (${response.status})`;
      return { ok: false, status: response.status, error };
    }
    return { ok: true, body: body as T };
  } catch {
    return { ok: false, status: 0, error: "could not reach the board server" };
  }
}

// Config, proposals ------------------------------------------------------------------------------

export function parseAgentConfig(value: unknown): AgentConfig {
  if (!isRecord(value) || value.enabled !== true) return { enabled: false };
  if (value.available !== true) return { enabled: true, available: false, reason: typeof value.reason === "string" ? value.reason : "unavailable" };
  return {
    enabled: true,
    available: true,
    user: { display: isRecord(value.user) && typeof value.user.display === "string" ? value.user.display : "" },
    ...(typeof value.mcpUrl === "string" && /^https?:\/\//.test(value.mcpUrl) ? { mcpUrl: value.mcpUrl } : {}),
    tools: Array.isArray(value.tools) ? value.tools.filter((tool): tool is string => typeof tool === "string") : [],
    csrf: typeof value.csrf === "string" ? value.csrf : "",
  };
}

export function parseProposal(value: unknown): Proposal | null {
  if (!isRecord(value)) return null;
  const { id, repo, branch, source, note, status, created, decided } = value;
  if (typeof id !== "string" || typeof repo !== "string" || typeof branch !== "string" || typeof created !== "string") return null;
  if (status !== "pending" && status !== "accepted" && status !== "rejected") return null;
  const edits = Array.isArray(value.edits)
    ? value.edits.flatMap((edit) => {
        const parsed = EditSchema.safeParse(edit);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
  return {
    id,
    repo,
    branch,
    source: typeof source === "string" ? source : "",
    note: typeof note === "string" ? note : "",
    edits,
    status,
    created,
    decided: typeof decided === "string" ? decided : null,
  };
}

export async function loadProposals(): Promise<void> {
  const result = await json<{ proposals: unknown[] }>("/api/agent/proposals");
  if (!result.ok) return;
  setState({ proposals: (result.body.proposals ?? []).flatMap((entry) => parseProposal(entry) ?? []) });
}

export function pendingProposals(proposals: readonly Proposal[], repo?: string): Proposal[] {
  return proposals.filter((proposal) => proposal.status === "pending" && (repo === undefined || proposal.repo === repo));
}

export async function acceptProposal(proposal: Proposal): Promise<string | null> {
  const result = await json(`/api/agent/proposals/${encodeURIComponent(proposal.id)}/accept`, {
    method: "POST",
    body: JSON.stringify({ csrf: csrf() }),
  });
  await loadProposals();
  if (!result.ok) return result.error;
  await pullBasket(proposal.repo, proposal.branch);
  return null;
}

export async function rejectProposal(proposal: Proposal): Promise<string | null> {
  const result = await json(`/api/agent/proposals/${encodeURIComponent(proposal.id)}/reject`, {
    method: "POST",
    body: JSON.stringify({ csrf: csrf() }),
  });
  await loadProposals();
  return result.ok ? null : result.error;
}

export async function acceptAllProposals(repo?: string): Promise<string | null> {
  const targets = pendingProposals(state.proposals, repo);
  const result = await json<{ failed: { error: string }[] }>("/api/agent/proposals/accept-all", {
    method: "POST",
    body: JSON.stringify({ csrf: csrf(), ...(repo === undefined ? {} : { repo }) }),
  });
  await loadProposals();
  for (const key of new Set(targets.map((proposal) => `${proposal.repo}\n${proposal.branch}`))) {
    const [targetRepo = "", branch = ""] = key.split("\n");
    await pullBasket(targetRepo, branch);
  }
  if (!result.ok) return result.error;
  return result.body.failed.length === 0 ? null : (result.body.failed[0]?.error ?? null);
}

// Tokens -----------------------------------------------------------------------------------------

export type AgentToken = { id: string; name: string; repos: string[] | null; created: string; lastUsed: string | null; revoked: string | null };

export async function listTokens(): Promise<AgentToken[] | string> {
  const result = await json<{ tokens: AgentToken[] }>("/api/agent/tokens");
  return result.ok ? result.body.tokens : result.error;
}

export async function createToken(name: string, repos: string[]): Promise<{ token: string } | { error: string }> {
  const result = await json<{ token: string }>("/api/agent/tokens", {
    method: "POST",
    body: JSON.stringify({ name, csrf: csrf(), ...(repos.length === 0 ? {} : { repos }) }),
  });
  return result.ok ? { token: result.body.token } : { error: result.error };
}

export async function revokeToken(id: string): Promise<string | null> {
  const result = await json(`/api/agent/tokens/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "x-snoboard-csrf": csrf() ?? "" },
  });
  return result.ok ? null : result.error;
}

// Basket sync ------------------------------------------------------------------------------------

/** The basket as last agreed with the server, per repository and branch (offline edits diff against it). */
export function syncBaseKey(repoId: string, branch: string): string {
  return `snoboard:basket-sync:v1:${repoId}:${branch}`;
}

type Base = { edits: Edit[]; updated: number };

function readBase(repoId: string, branch: string): Base | null {
  try {
    const raw = localStorage.getItem(syncBaseKey(repoId, branch));
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || typeof value.updated !== "number" || !Array.isArray(value.edits)) return null;
    return { updated: value.updated, edits: value.edits.flatMap((edit) => {
      const parsed = EditSchema.safeParse(edit);
      return parsed.success ? [parsed.data] : [];
    }) };
  } catch {
    return null;
  }
}

function writeBase(repoId: string, branch: string, base: Base): void {
  try {
    localStorage.setItem(syncBaseKey(repoId, branch), JSON.stringify(base));
  } catch {
    // Storage full: the next sync starts from the server again.
  }
}

const inFlight = new Map<string, Promise<void>>();
const again = new Set<string>();
const timers = new Map<string, number>();
export const PUSH_DELAY_MS = 300;

function same(left: readonly Edit[], right: readonly Edit[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Runs one sync step per basket at a time; a request while one runs schedules one more. */
function serialized(repoId: string, branch: string, work: () => Promise<void>): Promise<void> {
  const key = `${repoId}\n${branch}`;
  const running = inFlight.get(key);
  if (running !== undefined) {
    again.add(key);
    return running;
  }
  const run = (async () => {
    try {
      await work();
    } finally {
      inFlight.delete(key);
      if (again.delete(key)) void serialized(repoId, branch, work);
    }
  })();
  inFlight.set(key, run);
  return run;
}

/** Pushes local changes (merged on the server against newer writes) and adopts the result. */
async function push(repoId: string, branch: string): Promise<void> {
  const local = [...readSavedBasket(repoId, branch)];
  const base = readBase(repoId, branch) ?? { edits: [], updated: 0 };
  if (same(base.edits, local) && base.updated > 0) return;
  const change = diffBaskets(base.edits, local);
  const result = await json<{ edits: unknown[]; updated: number }>("/api/agent/basket", {
    method: "PUT",
    body: JSON.stringify({ repo: repoId, branch, edits: local, baseUpdated: base.updated, ...change, csrf: csrf() }),
  });
  if (!result.ok) return;
  adopt(repoId, branch, result.body);
}

function adopt(repoId: string, branch: string, body: { edits: unknown[]; updated: number }): void {
  if (!Array.isArray(body.edits) || typeof body.updated !== "number") return;
  const edits = body.edits.flatMap((edit) => {
    const parsed = EditSchema.safeParse(edit);
    return parsed.success ? [parsed.data] : [];
  });
  writeBase(repoId, branch, { edits, updated: body.updated });
  replaceSavedBasket(repoId, branch, edits);
}

/**
 * Brings a basket up to date: the server's version when this device changed nothing since the
 * last sync, else this device's changes merged into it.
 */
export function pullBasket(repoId: string, branch: string): Promise<void> {
  if (csrf() === undefined) return Promise.resolve();
  return serialized(repoId, branch, async () => {
    const result = await json<{ edits: unknown[]; updated: number }>(
      `/api/agent/basket?repo=${encodeURIComponent(repoId)}&branch=${encodeURIComponent(branch)}`,
    );
    if (!result.ok) return;
    const base = readBase(repoId, branch);
    const local = readSavedBasket(repoId, branch);
    if ((base !== null && same(base.edits, local)) || (base === null && local.length === 0)) {
      adopt(repoId, branch, result.body);
      return;
    }
    await push(repoId, branch);
  });
}

function schedulePush(repoId: string, branch: string): void {
  const key = `${repoId}\n${branch}`;
  window.clearTimeout(timers.get(key));
  timers.set(
    key,
    window.setTimeout(() => {
      timers.delete(key);
      void serialized(repoId, branch, () => push(repoId, branch));
    }, PUSH_DELAY_MS),
  );
}

const openBaskets = new Set<string>();

// Live events ------------------------------------------------------------------------------------

let source: EventSource | null = null;

function openEvents(): void {
  if (typeof EventSource === "undefined" || source !== null) return;
  source = new EventSource("/api/events", { withCredentials: true });
  source.addEventListener("ready", () => {
    setState({ live: true });
    // Catch up on anything missed while disconnected.
    void loadProposals();
    for (const key of openBaskets) {
      const [repoId = "", branch = ""] = key.split("\n");
      void pullBasket(repoId, branch);
    }
  });
  source.addEventListener("proposal", () => {
    void loadProposals();
  });
  source.addEventListener("basket", (event) => {
    const data = parseEventData(event);
    if (data === null || typeof data.repo !== "string" || typeof data.branch !== "string") return;
    const base = readBase(data.repo, data.branch);
    if (base !== null && typeof data.updated === "number" && base.updated >= data.updated) return;
    void pullBasket(data.repo, data.branch);
  });
  source.addEventListener("snapshot", (event) => {
    const data = parseEventData(event);
    if (data === null || typeof data.repo !== "string") return;
    const ref = typeof data.ref === "string" ? data.ref : null;
    for (const listener of snapshotListeners) listener(data.repo, ref);
  });
  source.onerror = () => setState({ live: false });
}

function parseEventData(event: Event): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse((event as MessageEvent<string>).data);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** Loads the bridge config and, when this person can use it, starts sync and live events. */
export async function startAgentBridge(): Promise<() => void> {
  const result = await json<unknown>("/api/agent/config");
  const config = result.ok ? parseAgentConfig(result.body) : ({ enabled: false } as const);
  setState({ config });
  if (!config.enabled || !config.available) return () => undefined;
  setBasketSyncHooks({
    onOpen: (repoId, branch) => {
      openBaskets.add(`${repoId}\n${branch}`);
      void pullBasket(repoId, branch);
    },
    onWrite: (repoId, branch) => schedulePush(repoId, branch),
  });
  void loadProposals();
  openEvents();
  const online = () => {
    for (const key of openBaskets) {
      const [repoId = "", branch = ""] = key.split("\n");
      void pullBasket(repoId, branch);
    }
  };
  window.addEventListener("online", online);
  return () => {
    window.removeEventListener("online", online);
    setBasketSyncHooks(null);
    source?.close();
    source = null;
  };
}

export function resetAgentBridge(): void {
  source?.close();
  source = null;
  state = INITIAL;
  openBaskets.clear();
  inFlight.clear();
  again.clear();
  for (const timer of timers.values()) window.clearTimeout(timer);
  timers.clear();
  snapshotListeners.clear();
  for (const listener of listeners) listener();
}

/** Tests: set the store directly. */
export function setAgentStateForTests(next: Partial<State>): void {
  setState(next);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
