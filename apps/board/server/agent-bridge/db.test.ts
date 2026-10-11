import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeDb, DECIDED_PROPOSAL_RETENTION_MS, hashToken, MAX_TOKENS_PER_USER } from "./db.js";

const dirs: string[] = [];

async function tempDb(): Promise<{ db: BridgeDb; file: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "snoboard-db-"));
  dirs.push(dir);
  const file = path.join(dir, "state", "snoboard.db");
  return { db: new BridgeDb(file), file };
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("bridge database", () => {
  it("applies migrations once, uses WAL and keeps the file private", async () => {
    const { db, file } = await tempDb();
    expect(db.versions()).toEqual([1]);
    const mode = db.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(mode.journal_mode).toBe("wal");
    db.close();
    const again = new BridgeDb(file);
    expect(again.versions()).toEqual([1]);
    again.close();
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
  });

  it("stores tokens as hashes, authenticates, and revokes only the owner's tokens", () => {
    const db = new BridgeDb(":memory:");
    const created = db.createToken("github:ada", "ada", "laptop", ["default"]);
    if ("error" in created) throw new Error("token not created");
    expect(created.token).toMatch(/^sbp_[A-Za-z0-9_-]{43}$/);
    const raw = db.db.prepare("SELECT hash FROM mcp_tokens").all() as { hash: string }[];
    expect(raw).toEqual([{ hash: hashToken(created.token) }]);
    expect(JSON.stringify(db.db.prepare("SELECT * FROM mcp_tokens").all())).not.toContain(created.token);

    const owner = db.authenticate(created.token);
    expect(owner).toMatchObject({ userKey: "github:ada", tokenName: "laptop", repos: ["default"] });
    expect(db.listTokens("github:ada")[0]?.lastUsed).not.toBeNull();
    // Always change the last character (a random token can already end in "A").
    const tampered = `${created.token.slice(0, -1)}${created.token.endsWith("A") ? "B" : "A"}`;
    expect(db.authenticate(tampered)).toBeNull();
    expect(db.authenticate("not-a-token")).toBeNull();

    expect(db.revokeToken("github:grace", created.row.id)).toBe(false);
    expect(db.authenticate(created.token)).not.toBeNull();
    expect(db.revokeToken("github:ada", created.row.id)).toBe(true);
    expect(db.revokeToken("github:ada", created.row.id)).toBe(false);
    expect(db.authenticate(created.token)).toBeNull();
    expect(db.listTokens("github:ada")[0]?.revoked).not.toBeNull();
    expect(db.listTokens("github:grace")).toEqual([]);
  });

  it("caps live tokens per user", () => {
    const db = new BridgeDb(":memory:");
    for (let index = 0; index < MAX_TOKENS_PER_USER; index += 1) {
      expect("token" in db.createToken("email:a@example.com", "a", `t${index}`, null)).toBe(true);
    }
    expect(db.createToken("email:a@example.com", "a", "one more", null)).toEqual({ error: "too_many" });
    expect("token" in db.createToken("email:b@example.com", "b", "other user", null)).toBe(true);
  });

  it("keeps baskets per user, repo and branch with a strictly growing version", () => {
    const db = new BridgeDb(":memory:");
    expect(db.getBasket("github:ada", "default", "main")).toEqual({ edits: [], updated: 0 });
    const first = db.putBasket("github:ada", "ada", "default", "main", [{ kind: "x" }], 1000);
    const second = db.putBasket("github:ada", "ada", "default", "main", [{ kind: "y" }], 1000);
    expect(first.updated).toBe(1000);
    expect(second.updated).toBe(1001);
    db.putBasket("github:grace", "grace", "default", "main", [{ kind: "z" }], 5000);
    expect(db.getBasket("github:ada", "default", "main").edits).toEqual([{ kind: "y" }]);
    expect(db.getBasket("github:ada", "default", "feat/x").edits).toEqual([]);
    expect(db.getBasket("github:grace", "default", "main").edits).toEqual([{ kind: "z" }]);
  });

  it("isolates proposals between users and decides each once", () => {
    const db = new BridgeDb(":memory:");
    const proposal = db.createProposal("github:ada", "ada", {
      repo: "default",
      branch: "main",
      source: "laptop",
      note: "move to planned",
      edits: [{ kind: "setStatus" }],
    });
    if ("error" in proposal) throw new Error("not created");
    expect(db.listProposals("github:ada").map((row) => row.id)).toEqual([proposal.id]);
    expect(db.listProposals("github:grace")).toEqual([]);
    expect(db.getProposal("github:grace", proposal.id)).toBeNull();
    expect(db.decideProposal("github:grace", proposal.id, "accepted")).toBe(false);
    expect(db.decideProposal("github:ada", proposal.id, "rejected")).toBe(true);
    expect(db.decideProposal("github:ada", proposal.id, "accepted")).toBe(false);
    expect(db.getProposal("github:ada", proposal.id)?.status).toBe("rejected");
    expect(db.listProposals("github:ada", { status: "pending" })).toEqual([]);
  });

  it("prunes old decided proposals", () => {
    const db = new BridgeDb(":memory:");
    const old = new Date("2026-01-01T00:00:00Z");
    const proposal = db.createProposal("github:ada", "ada", { repo: "r", branch: "main", source: "t", note: "", edits: [] }, old);
    if ("error" in proposal) throw new Error("not created");
    db.decideProposal("github:ada", proposal.id, "accepted", old);
    db.createProposal(
      "github:ada",
      "ada",
      { repo: "r", branch: "main", source: "t", note: "", edits: [] },
      new Date(old.getTime() + DECIDED_PROPOSAL_RETENTION_MS + 1000),
    );
    expect(db.getProposal("github:ada", proposal.id)).toBeNull();
  });
});
