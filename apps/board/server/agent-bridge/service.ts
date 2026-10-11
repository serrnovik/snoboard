import {
  bodyHash,
  docHash,
  EditSchema,
  isNewDocPath,
  isValidBranchName,
  MAX_DOC_BYTES,
  mergeBaskets,
  mergeIntoBasket,
  type BasketChange,
  type BoardItem,
  type Config,
  type Edit,
  type Snapshot,
} from "snoboard";
import { initiativeBody, isKnownRepo, readerFor, resolveRefView, utcToday } from "../api.js";
import { MAX_VALIDATE_EDITS, prepareEdits, type EditResult } from "../edits/prepare.js";
import { lookupDocument } from "../reports.js";
import { initiativeRepoDir, readCommittedBytes, readCommittedFile } from "../repo-sync.js";
import { getConfig } from "../store.js";
import type { BasketRow, BridgeDb, ProposalRow } from "./db.js";
import { publishToUser } from "./events.js";
import type { BridgeUser } from "./settings.js";

/** A proposal's edits, serialized, at most this many bytes (one document edit is up to 60,000 characters). */
export const MAX_PROPOSAL_BYTES = 192 * 1024;
/** A synced basket, serialized. */
export const MAX_BASKET_BYTES = 512 * 1024;
export const MAX_NOTE_LENGTH = 2000;

export type BranchView = { snapshot: Snapshot; config: Config; repoDir: string | undefined; ref: string | undefined };

export type ViewResult = { ok: true; view: BranchView } | { ok: false; code: string; error: string };

/**
 * The snapshot an edit for `branch` is checked against. The default branch uses the merged board
 * (as the browser's default basket does); any other branch is read alone.
 */
export async function viewForBranch(repoId: string, branch: string): Promise<ViewResult> {
  if (!isKnownRepo(repoId)) return { ok: false, code: "unknown_repo", error: "unknown repository" };
  if (!isValidBranchName(branch)) return { ok: false, code: "invalid_branch", error: "invalid branch name" };
  const config = getConfig(repoId);
  if (config === null) return { ok: false, code: "not_ready", error: "snapshot not ready" };
  const ref = branch === config.defaultBranch ? undefined : branch;
  const resolved = await resolveRefView(repoId, ref);
  if (!resolved.ok) return { ok: false, code: resolved.code, error: resolved.error };
  if (resolved.snapshot === null) return { ok: false, code: "not_ready", error: "snapshot not ready" };
  return { ok: true, view: { snapshot: resolved.snapshot, config, repoDir: initiativeRepoDir(repoId), ref } };
}

/** Read-only routes take an optional ref: none (or the default branch) means the merged board. */
export async function viewForRef(repoId: string, ref: string | undefined): Promise<ViewResult> {
  const config = getConfig(repoId);
  return viewForBranch(repoId, ref ?? config?.defaultBranch ?? "main");
}

export async function readInitiativeFile(view: BranchView, item: BoardItem): Promise<string | undefined> {
  if (view.repoDir === undefined) return undefined;
  try {
    return await readCommittedFile(view.repoDir, item.sourceSha, item.path);
  } catch {
    return undefined;
  }
}

/** Text of a listed document (`.md` or `.html`) and the sha256 of the whole file. */
export async function readDocument(
  view: BranchView,
  item: BoardItem,
  relative: string,
): Promise<{ text: string; hash: string; format: "md" | "html"; path: string } | { error: string }> {
  const found = lookupDocument(view.snapshot, item, relative);
  if (!found.ok) return { error: "not a listed document of this initiative" };
  if (found.kind !== "md" && found.kind !== "html") return { error: "not a text document" };
  if (view.repoDir === undefined) return { error: "snapshot not ready" };
  const bytes = await readCommittedBytes(view.repoDir, found.sha, found.path, MAX_DOC_BYTES).catch(() => undefined);
  if (bytes === undefined) return { error: "document could not be read (missing or over 2 MB)" };
  const text = bytes.toString("utf8");
  return { text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, hash: docHash(text), format: found.kind, path: relative };
}

type RawEdit = Record<string, unknown>;

/**
 * Agents may leave out what the board knows: `from` for field edits and `fromHash` for body and
 * document edits are filled from the snapshot of the target branch. Given values are kept, so an
 * agent that read the file first still gets a stale check against what it read.
 */
export async function fillEdits(view: BranchView, edits: readonly unknown[]): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const raw of edits) {
    if (!isRecord(raw) || typeof raw.kind !== "string" || typeof raw.id !== "string") {
      out.push(raw);
      continue;
    }
    const item = view.snapshot.items.find((entry) => entry.id === raw.id);
    if (item === undefined) {
      out.push(raw);
      continue;
    }
    out.push(await fillOne(view, item, raw));
  }
  return out;
}

async function fillOne(view: BranchView, item: BoardItem, raw: RawEdit): Promise<RawEdit> {
  const has = (key: string) => raw[key] !== undefined;
  switch (raw.kind) {
    case "setStatus":
      return has("from") ? raw : { ...raw, from: item.status };
    case "setPriority":
      return has("from") ? raw : { ...raw, from: item.priority };
    case "setTitle":
      return has("from") ? raw : { ...raw, from: item.title };
    case "setIcon":
      return has("from") ? raw : { ...raw, from: item.icon ?? "" };
    case "setLabels":
      return has("from") ? raw : { ...raw, from: item.labels ?? [] };
    case "setIssues":
      return has("from") ? raw : { ...raw, from: item.issues ?? [] };
    case "setLinks":
      return has("from") ? raw : { ...raw, from: (item.links ?? []).map((link) => ({ title: link.title, url: link.url })) };
    case "setPhaseStatus": {
      if (has("from")) return raw;
      const phase = item.phases?.find((entry) => entry.id === raw.phase);
      return phase === undefined ? raw : { ...raw, from: phase.status };
    }
    case "setBody": {
      if (has("fromHash")) return raw;
      const text = await readInitiativeFile(view, item);
      return text === undefined ? raw : { ...raw, fromHash: bodyHash(text) };
    }
    case "setDoc": {
      if (has("fromHash") || typeof raw.path !== "string") return raw;
      const doc = await readDocument(view, item, raw.path);
      return "error" in doc ? raw : { ...raw, fromHash: doc.hash };
    }
    default:
      return raw;
  }
}

export type CheckedEdits =
  | { ok: true; edits: Edit[]; results: EditResult[] }
  | { ok: false; code: string; error: string; results?: EditResult[] };

/** Same checks as `POST /api/repos/<repo>/edits/validate`, against the target branch. */
export async function checkEdits(view: BranchView, raw: readonly unknown[]): Promise<CheckedEdits> {
  if (raw.length === 0) return { ok: false, code: "invalid", error: "no edits" };
  if (raw.length > MAX_VALIDATE_EDITS) return { ok: false, code: "invalid", error: `at most ${MAX_VALIDATE_EDITS} edits` };
  if (raw.some((edit) => isRecord(edit) && edit.kind === "addAttachment")) {
    return { ok: false, code: "invalid", error: "images cannot be proposed by an agent; add them in the board" };
  }
  const prepared = await prepareEdits(raw, view.snapshot, readerFor(view.repoDir, view.config), view.config, utcToday());
  if (prepared.results.some((result) => !result.ok)) {
    return { ok: false, code: "rejected", error: "some edits do not apply; nothing was stored", results: prepared.results };
  }
  const edits = raw.map((edit) => EditSchema.parse(edit));
  return { ok: true, edits, results: prepared.results };
}

export type ProposeResult =
  | { ok: true; proposal: ProposalRow; results: EditResult[] }
  | { ok: false; code: string; error: string; results?: EditResult[] };

export async function proposeEdits(
  db: BridgeDb,
  user: BridgeUser,
  input: { repo: string; branch: string; source: string; note: string; edits: readonly unknown[] },
): Promise<ProposeResult> {
  if (input.note.length > MAX_NOTE_LENGTH) return { ok: false, code: "invalid", error: `note is over ${MAX_NOTE_LENGTH} characters` };
  const resolved = await viewForBranch(input.repo, input.branch);
  if (!resolved.ok) return resolved;
  const filled = await fillEdits(resolved.view, input.edits);
  const checked = await checkEdits(resolved.view, filled);
  if (!checked.ok) return checked;
  if (Buffer.byteLength(JSON.stringify(checked.edits), "utf8") > MAX_PROPOSAL_BYTES) {
    return { ok: false, code: "too_large", error: `a proposal is at most ${MAX_PROPOSAL_BYTES / 1024} KiB of edits` };
  }
  const stored = db.createProposal(user.key, user.display, { ...input, edits: checked.edits });
  if ("error" in stored) return { ok: false, code: "too_many", error: "too many pending proposals; accept or reject some first" };
  publishToUser(user.key, { type: "proposal", id: stored.id, repo: stored.repo, branch: stored.branch, status: "pending" });
  return { ok: true, proposal: stored, results: checked.results };
}

/** `setDoc` with the server's hash when the document exists, else `createDoc` for a new phase or top-level file. */
export async function docEditFromLocal(
  view: BranchView,
  input: { id: string; path: string; content: string },
): Promise<{ ok: true; edit: RawEdit } | { ok: false; error: string }> {
  const item = view.snapshot.items.find((entry) => entry.id === input.id);
  if (item === undefined) return { ok: false, error: `${input.id}: initiative not found on this branch` };
  const existing = await readDocument(view, item, input.path);
  if (!("error" in existing)) {
    if (existing.format !== "md") return { ok: false, error: "only markdown documents can be edited" };
    return { ok: true, edit: { kind: "setDoc", id: input.id, path: input.path, fromHash: existing.hash, to: input.content } };
  }
  if (isNewDocPath(input.path)) return { ok: true, edit: { kind: "createDoc", id: input.id, path: input.path, to: input.content } };
  return { ok: false, error: `${input.path}: ${existing.error}` };
}

/** Parses stored edits; anything that no longer parses is dropped. */
export function parseEdits(raw: readonly unknown[]): Edit[] {
  return raw.flatMap((edit) => {
    const parsed = EditSchema.safeParse(edit);
    return parsed.success ? [parsed.data] : [];
  });
}

export type BasketWrite = { ok: true; basket: BasketRow; merged: boolean } | { ok: false; code: string; error: string };

/**
 * Last write wins when the writer saw the newest version (`baseUpdated`); otherwise the writer's
 * own changes are merged by edit key into what is stored, so two devices never drop each other's edits.
 */
export function writeBasket(
  db: BridgeDb,
  user: BridgeUser,
  input: { repo: string; branch: string; edits: readonly Edit[]; baseUpdated: number; change: BasketChange },
  source: "browser" | "agent" | "inbox",
): BasketWrite {
  if (Buffer.byteLength(JSON.stringify(input.edits), "utf8") > MAX_BASKET_BYTES) {
    return { ok: false, code: "too_large", error: "basket too large" };
  }
  const result = db.transaction(() => {
    const stored = db.getBasket(user.key, input.repo, input.branch);
    const fastForward = stored.updated === input.baseUpdated;
    const next = fastForward ? [...input.edits] : mergeBaskets(parseEdits(stored.edits), input.edits, input.change);
    if (!fastForward || JSON.stringify(next) !== JSON.stringify(stored.edits) || stored.updated === 0) {
      return { basket: db.putBasket(user.key, user.display, input.repo, input.branch, next), merged: !fastForward, wrote: true };
    }
    return { basket: stored, merged: false, wrote: false };
  });
  if (result.wrote) {
    publishToUser(user.key, { type: "basket", repo: input.repo, branch: input.branch, updated: result.basket.updated, source });
  }
  return { ok: true, basket: result.basket, merged: result.merged };
}

/** Queues a pending proposal's edits in the user's basket for its repo and branch, then marks it accepted. */
export function acceptProposal(
  db: BridgeDb,
  user: BridgeUser,
  id: string,
): { ok: true; proposal: ProposalRow; basket: BasketRow } | { ok: false; code: string; error: string } {
  const outcome = db.transaction(() => {
    const proposal = db.getProposal(user.key, id);
    if (proposal === null) return { ok: false as const, code: "not_found", error: "proposal not found" };
    if (proposal.status !== "pending") return { ok: false as const, code: "decided", error: `proposal already ${proposal.status}` };
    const stored = db.getBasket(user.key, proposal.repo, proposal.branch);
    let next = parseEdits(stored.edits);
    for (const edit of parseEdits(proposal.edits)) next = mergeIntoBasket(next, edit);
    if (Buffer.byteLength(JSON.stringify(next), "utf8") > MAX_BASKET_BYTES) {
      return { ok: false as const, code: "too_large", error: "the basket would be too large; submit it first" };
    }
    const basket = db.putBasket(user.key, user.display, proposal.repo, proposal.branch, next);
    db.decideProposal(user.key, id, "accepted");
    return { ok: true as const, proposal: { ...proposal, status: "accepted" as const }, basket };
  });
  if (outcome.ok) {
    const { proposal, basket } = outcome;
    publishToUser(user.key, { type: "basket", repo: proposal.repo, branch: proposal.branch, updated: basket.updated, source: "inbox" });
    publishToUser(user.key, { type: "proposal", id, repo: proposal.repo, branch: proposal.branch, status: "accepted" });
  }
  return outcome;
}

export function rejectProposal(db: BridgeDb, user: BridgeUser, id: string): { ok: true } | { ok: false; code: string; error: string } {
  const proposal = db.getProposal(user.key, id);
  if (proposal === null) return { ok: false, code: "not_found", error: "proposal not found" };
  if (!db.decideProposal(user.key, id, "rejected")) return { ok: false, code: "decided", error: `proposal already ${proposal.status}` };
  publishToUser(user.key, { type: "proposal", id, repo: proposal.repo, branch: proposal.branch, status: "rejected" });
  return { ok: true };
}

/** `---` frontmatter text and body of an initiative file. */
export function splitInitiative(text: string): { frontmatter: string; body: string } | null {
  const body = initiativeBody(text);
  if (body === null) return null;
  const source = text.startsWith("﻿") ? text.slice(1) : text;
  const end = source.length - body.length;
  const head = source.slice(0, end);
  const frontmatter = head.replace(/^---\r?\n/, "").replace(/\r?\n---[ \t]*(?:\r?\n)?$/, "");
  return { frontmatter, body };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
