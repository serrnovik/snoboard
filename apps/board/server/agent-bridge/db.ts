import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Per-user state for the agent bridge: personal MCP tokens (stored as SHA-256 hashes), server-side
 * baskets and agent proposals. One SQLite file (WAL mode, mode 0600) in the state directory.
 * Every query is scoped by `user_key`; nothing here reads another user's rows.
 */

export const DB_FILE_NAME = "snoboard.db";
export const TOKEN_PREFIX = "sbp_";
export const MAX_TOKENS_PER_USER = 20;
export const MAX_PENDING_PROPOSALS_PER_USER = 200;
/** Decided proposals are kept this long, then pruned. */
export const DECIDED_PROPOSAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type ProposalStatus = "pending" | "accepted" | "rejected";

export type TokenRow = {
  id: string;
  name: string;
  /** Repository ids the token may use; null for every repository the board serves. */
  repos: string[] | null;
  created: string;
  lastUsed: string | null;
  revoked: string | null;
};

export type TokenOwner = { tokenId: string; tokenName: string; userKey: string; display: string; repos: string[] | null };

export type BasketRow = { edits: unknown[]; updated: number };

export type ProposalRow = {
  id: string;
  repo: string;
  branch: string;
  source: string;
  note: string;
  edits: unknown[];
  status: ProposalStatus;
  created: string;
  decided: string | null;
};

type Migration = { version: number; sql: string };

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE users (
        key TEXT PRIMARY KEY,
        display TEXT NOT NULL,
        created TEXT NOT NULL,
        last_seen TEXT NOT NULL
      );
      CREATE TABLE mcp_tokens (
        id TEXT PRIMARY KEY,
        user_key TEXT NOT NULL REFERENCES users(key) ON DELETE CASCADE,
        name TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        repos TEXT,
        created TEXT NOT NULL,
        last_used TEXT,
        revoked TEXT
      );
      CREATE INDEX mcp_tokens_user ON mcp_tokens(user_key);
      CREATE TABLE baskets (
        user_key TEXT NOT NULL REFERENCES users(key) ON DELETE CASCADE,
        repo TEXT NOT NULL,
        branch TEXT NOT NULL,
        json TEXT NOT NULL,
        updated INTEGER NOT NULL,
        PRIMARY KEY (user_key, repo, branch)
      );
      CREATE TABLE proposals (
        id TEXT PRIMARY KEY,
        user_key TEXT NOT NULL REFERENCES users(key) ON DELETE CASCADE,
        repo TEXT NOT NULL,
        branch TEXT NOT NULL,
        source TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        edits TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected')),
        created TEXT NOT NULL,
        decided TEXT
      );
      CREATE INDEX proposals_user ON proposals(user_key, status, created);
    `,
  },
];

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** `sbp_` + 43 base64url characters (32 random bytes). */
export function isTokenShape(value: string): boolean {
  return /^sbp_[A-Za-z0-9_-]{43}$/.test(value);
}

export class BridgeDb {
  readonly db: DatabaseSync;
  readonly file: string;

  constructor(file: string) {
    this.file = file;
    if (file !== ":memory:") {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    if (file !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
    }
    this.migrate();
    this.restrictPermissions();
  }

  close(): void {
    this.db.close();
  }

  /** Applied schema versions, oldest first. */
  versions(): number[] {
    return (this.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: number }[]).map(
      (row) => Number(row.version),
    );
  }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied TEXT NOT NULL)");
    const applied = new Set(this.versions());
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      this.transaction(() => {
        this.db.exec(migration.sql);
        this.db
          .prepare("INSERT INTO schema_migrations (version, applied) VALUES (?, ?)")
          .run(migration.version, new Date().toISOString());
      });
    }
  }

  /** The database and its WAL files hold user data: owner read/write only (no-op on Windows). */
  private restrictPermissions(): void {
    if (this.file === ":memory:" || process.platform === "win32") return;
    for (const suffix of ["", "-wal", "-shm"]) {
      const target = `${this.file}${suffix}`;
      if (existsSync(target)) chmodSync(target, 0o600);
    }
  }

  /** Runs `work` in one write transaction. Nested calls join the outer one. */
  transaction<T>(work: () => T): T {
    if (this.db.isTransaction) return work();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  touchUser(key: string, display: string, now = new Date()): void {
    const at = now.toISOString();
    this.db
      .prepare(
        "INSERT INTO users (key, display, created, last_seen) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET display = excluded.display, last_seen = excluded.last_seen",
      )
      .run(key, display.slice(0, 200), at, at);
  }

  // Tokens ------------------------------------------------------------------------------------

  /** Creates a token and returns its secret once. Only the SHA-256 hash is stored. */
  createToken(
    userKey: string,
    display: string,
    name: string,
    repos: string[] | null,
    now = new Date(),
  ): { token: string; row: TokenRow } | { error: "too_many" } {
    return this.transaction(() => {
      this.touchUser(userKey, display, now);
      const active = this.db
        .prepare("SELECT COUNT(*) AS n FROM mcp_tokens WHERE user_key = ? AND revoked IS NULL")
        .get(userKey) as { n: number };
      if (Number(active.n) >= MAX_TOKENS_PER_USER) return { error: "too_many" as const };
      const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
      const id = randomBytes(9).toString("base64url");
      const created = now.toISOString();
      this.db
        .prepare("INSERT INTO mcp_tokens (id, user_key, name, hash, repos, created) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, userKey, name, hashToken(token), repos === null ? null : JSON.stringify(repos), created);
      return { token, row: { id, name, repos, created, lastUsed: null, revoked: null } };
    });
  }

  listTokens(userKey: string): TokenRow[] {
    const rows = this.db
      .prepare("SELECT id, name, repos, created, last_used, revoked FROM mcp_tokens WHERE user_key = ? ORDER BY created DESC, id")
      .all(userKey) as {
      id: string;
      name: string;
      repos: string | null;
      created: string;
      last_used: string | null;
      revoked: string | null;
    }[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      repos: parseRepos(row.repos),
      created: row.created,
      lastUsed: row.last_used,
      revoked: row.revoked,
    }));
  }

  /** Revokes one of the user's own tokens. False when the id is not theirs or already revoked. */
  revokeToken(userKey: string, id: string, now = new Date()): boolean {
    const result = this.db
      .prepare("UPDATE mcp_tokens SET revoked = ? WHERE id = ? AND user_key = ? AND revoked IS NULL")
      .run(now.toISOString(), id, userKey);
    return Number(result.changes) > 0;
  }

  /** The owner of a live token, or null. Records `last_used`. */
  authenticate(token: string, now = new Date()): TokenOwner | null {
    if (!isTokenShape(token)) return null;
    const hash = hashToken(token);
    const row = this.db
      .prepare(
        "SELECT t.id, t.name, t.hash, t.repos, t.user_key, u.display FROM mcp_tokens t JOIN users u ON u.key = t.user_key WHERE t.hash = ? AND t.revoked IS NULL",
      )
      .get(hash) as
      | { id: string; name: string; hash: string; repos: string | null; user_key: string; display: string }
      | undefined;
    if (row === undefined) return null;
    // Found by hash; compare again in constant time so the match never rests on the index alone.
    if (!timingSafeEqual(Buffer.from(row.hash, "hex"), Buffer.from(hash, "hex"))) return null;
    this.db.prepare("UPDATE mcp_tokens SET last_used = ? WHERE id = ?").run(now.toISOString(), row.id);
    return { tokenId: row.id, tokenName: row.name, userKey: row.user_key, display: row.display, repos: parseRepos(row.repos) };
  }

  // Baskets -----------------------------------------------------------------------------------

  getBasket(userKey: string, repo: string, branch: string): BasketRow {
    const row = this.db
      .prepare("SELECT json, updated FROM baskets WHERE user_key = ? AND repo = ? AND branch = ?")
      .get(userKey, repo, branch) as { json: string; updated: number } | undefined;
    if (row === undefined) return { edits: [], updated: 0 };
    return { edits: parseArray(row.json), updated: Number(row.updated) };
  }

  /**
   * Stores a basket. `updated` grows strictly, so every write is newer than the last one even
   * within the same millisecond.
   */
  putBasket(
    userKey: string,
    display: string,
    repo: string,
    branch: string,
    edits: readonly unknown[],
    now = Date.now(),
  ): BasketRow {
    return this.transaction(() => {
      this.touchUser(userKey, display, new Date(now));
      const previous = this.getBasket(userKey, repo, branch).updated;
      const updated = Math.max(now, previous + 1);
      this.db
        .prepare(
          "INSERT INTO baskets (user_key, repo, branch, json, updated) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_key, repo, branch) DO UPDATE SET json = excluded.json, updated = excluded.updated",
        )
        .run(userKey, repo, branch, JSON.stringify(edits), updated);
      return { edits: [...edits], updated };
    });
  }

  // Proposals ---------------------------------------------------------------------------------

  createProposal(
    userKey: string,
    display: string,
    input: { repo: string; branch: string; source: string; note: string; edits: readonly unknown[] },
    now = new Date(),
  ): ProposalRow | { error: "too_many" } {
    return this.transaction(() => {
      this.touchUser(userKey, display, now);
      this.pruneDecided(userKey, now);
      const pending = this.db
        .prepare("SELECT COUNT(*) AS n FROM proposals WHERE user_key = ? AND status = 'pending'")
        .get(userKey) as { n: number };
      if (Number(pending.n) >= MAX_PENDING_PROPOSALS_PER_USER) return { error: "too_many" as const };
      const id = `p_${randomBytes(9).toString("base64url")}`;
      const created = now.toISOString();
      this.db
        .prepare(
          "INSERT INTO proposals (id, user_key, repo, branch, source, note, edits, status, created) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
        )
        .run(id, userKey, input.repo, input.branch, input.source, input.note, JSON.stringify(input.edits), created);
      return {
        id,
        repo: input.repo,
        branch: input.branch,
        source: input.source,
        note: input.note,
        edits: [...input.edits],
        status: "pending" as const,
        created,
        decided: null,
      };
    });
  }

  listProposals(userKey: string, filter: { repo?: string; status?: ProposalStatus; limit?: number } = {}): ProposalRow[] {
    const clauses = ["user_key = ?"];
    const values: (string | number)[] = [userKey];
    if (filter.repo !== undefined) {
      clauses.push("repo = ?");
      values.push(filter.repo);
    }
    if (filter.status !== undefined) {
      clauses.push("status = ?");
      values.push(filter.status);
    }
    values.push(Math.min(Math.max(filter.limit ?? 100, 1), 500));
    const rows = this.db
      .prepare(
        `SELECT id, repo, branch, source, note, edits, status, created, decided FROM proposals WHERE ${clauses.join(" AND ")} ORDER BY created DESC, id LIMIT ?`,
      )
      .all(...values) as RawProposal[];
    return rows.map(toProposal);
  }

  getProposal(userKey: string, id: string): ProposalRow | null {
    const row = this.db
      .prepare(
        "SELECT id, repo, branch, source, note, edits, status, created, decided FROM proposals WHERE user_key = ? AND id = ?",
      )
      .get(userKey, id) as RawProposal | undefined;
    return row === undefined ? null : toProposal(row);
  }

  /** Decides a pending proposal of this user. False when it is not theirs or not pending. */
  decideProposal(userKey: string, id: string, status: Exclude<ProposalStatus, "pending">, now = new Date()): boolean {
    const result = this.db
      .prepare("UPDATE proposals SET status = ?, decided = ? WHERE user_key = ? AND id = ? AND status = 'pending'")
      .run(status, now.toISOString(), userKey, id);
    return Number(result.changes) > 0;
  }

  private pruneDecided(userKey: string, now: Date): void {
    const cutoff = new Date(now.getTime() - DECIDED_PROPOSAL_RETENTION_MS).toISOString();
    this.db.prepare("DELETE FROM proposals WHERE user_key = ? AND status != 'pending' AND decided < ?").run(userKey, cutoff);
  }
}

type RawProposal = {
  id: string;
  repo: string;
  branch: string;
  source: string;
  note: string;
  edits: string;
  status: ProposalStatus;
  created: string;
  decided: string | null;
};

function toProposal(row: RawProposal): ProposalRow {
  return {
    id: row.id,
    repo: row.repo,
    branch: row.branch,
    source: row.source,
    note: row.note,
    edits: parseArray(row.edits),
    status: row.status,
    created: row.created,
    decided: row.decided,
  };
}

function parseArray(text: string): unknown[] {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function parseRepos(text: string | null): string[] | null {
  if (text === null) return null;
  return parseArray(text).filter((entry): entry is string => typeof entry === "string");
}
