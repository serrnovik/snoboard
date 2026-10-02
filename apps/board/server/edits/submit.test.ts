import { createHash, createSign, generateKeyPairSync, randomBytes, type JsonWebKey, type KeyObject } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bodyHash, buildSnapshot, loadConfig, type Config, type Snapshot } from "snoboard";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTmpRepo } from "../../../../packages/core/src/test-utils/tmp-repo.ts";
import { resetAuthConfig, setAuthConfig } from "../auth/env.js";
import { OAUTH_COOKIE, openOAuthPending } from "../auth/github.js";
import { SESSION_COOKIE, signSession, type SessionClaims } from "../auth/session.js";
import { resetWriteTokens, storeWriteToken, WRITE_COOKIE, writeTokenCount } from "../auth/write-tokens.js";
import { resetEditConfig, setEditConfig, type EditSettings } from "../edit-env.js";
import { app } from "../index.js";
import { setInitiativeRepoDir } from "../repo-sync.js";
import { resetStore, seedStore } from "../store.js";
import {
  allowSubmit,
  chooseSubmitCredential,
  commitMessage,
  isEditablePath,
  PASSWORD_BOT_IDENTITY,
  passwordIdentity,
  readBotTokenFile,
  resetSubmitState,
  SUBMIT_LIMIT_PER_HOUR,
} from "./submit.js";

const refresh = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../repo-sync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repo-sync.js")>();
  return { ...actual, requestRefresh: refresh };
});

const TOKEN = "gho_synthetic-user-write-token-42";
const REPO = "acme/board";
const ORIGIN = "https://board.example";
const secret = randomBytes(32);
const ALPHA = "initiatives/acme/001-alpha/initiative.md";
const BETA = "initiatives/acme/002-beta/initiative.md";

const alphaText = `---
id: acme-001
title: Alpha
status: idea
priority: p2
updated: 2026-09-01
---

# Alpha

## Summary

Keep this prose.
`;

const betaText = `---
id: acme-002
title: Beta
status: planned
priority: p1
updated: 2026-09-01
---

# Beta
`;

const configText = `forge:\n  repo: ${REPO}\n`;

let snapshot: Snapshot;
let config: Config;
let repoDir: string;
let removeRepo: () => Promise<void>;
const logs: string[] = [];

beforeAll(async () => {
  config = loadConfig(configText);
  const repo = await createTmpRepo({
    commits: [{ message: "main", files: { [ALPHA]: alphaText, [BETA]: betaText, ".snoboard.yml": configText } }],
  });
  repoDir = repo.dir;
  removeRepo = repo.remove;
  snapshot = await buildSnapshot(repo.dir, config);
}, 60_000);

afterAll(async () => {
  await removeRepo();
});

describe("POST /api/edits/submit", () => {
  let github: FakeGithub;

  beforeEach(() => {
    logs.length = 0;
    for (const level of ["info", "warn", "error", "log"] as const) {
      vi.spyOn(console, level).mockImplementation((...args) => void logs.push(args.map(String).join(" ")));
    }
    setAuthConfig({
      modes: ["github"],
      publicUrl: ORIGIN,
      sessionSecret: secret,
      github: { clientId: "client-id", clientSecret: "client-secret", allowedLogins: ["octocat"], allowedOrgs: [] },
    });
    useEdits({ modes: ["pr", "direct"], directBranch: "main" });
    seedStore(snapshot, config);
    setInitiativeRepoDir(repoDir);
    github = new FakeGithub({ [ALPHA]: alphaText, [BETA]: betaText });
    vi.stubGlobal("fetch", github.fetch);
    refresh.mockClear();
  });

  afterEach(() => {
    // Nothing we returned or logged may carry the token.
    expect(logs.join("\n")).not.toContain(TOKEN);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetAuthConfig();
    resetEditConfig();
    resetStore();
    resetWriteTokens();
    resetSubmitState();
    setInitiativeRepoDir(undefined);
    delete process.env.SNOBOARD_EDIT_BOT_TOKEN_FILE;
    delete process.env.SNOBOARD_PASSWORD_NAME;
  });

  it("pr: one commit on a new edits branch, one PR, the label, and exact audit lines", async () => {
    const user = await signIn();
    const edits = [
      { kind: "setStatus", id: "acme-001", from: "idea", to: "planned" },
      { kind: "setPriority", id: "acme-002", from: "p1", to: "p0" },
    ];
    const response = await submit(user, { edits, mode: "pr" });
    const body = await json(response);
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, mode: "pr", warnings: [], reapplied: [] });
    expect(body.branch).toMatch(/^snoboard\/edits-\d{8}-\d{6}-[0-9a-f]{4}$/);
    expect(body.pr).toEqual({ number: 1, url: `https://github.com/${REPO}/pull/1` });
    expect(github.refs.get("main")).toBe(github.initialHead);
    expect(github.refs.get(body.branch)).toBe(body.commit);
    expect(github.commitCount()).toBe(1);
    const commit = github.commit(body.commit);
    expect(commit.parents).toEqual([github.initialHead]);
    expect(commit.message).toBe(
      [
        "snoboard: 2 edits by octocat",
        "",
        "Snoboard-Edit: acme-001: status idea -> planned",
        "Snoboard-Edit: acme-002: priority p1 -> p0",
        "Snoboard-Edit-By: octocat",
        "",
      ].join("\n"),
    );
    const alpha = github.fileAt(body.commit, ALPHA) ?? "";
    expect(alpha).toContain("status: planned");
    expect(alpha.slice(alpha.indexOf("\n---\n"))).toBe(alphaText.slice(alphaText.indexOf("\n---\n")));
    expect(github.fileAt(body.commit, BETA)).toContain("priority: p0");
    expect(github.pulls[0]).toMatchObject({ head: body.branch, base: "main", title: "snoboard: 2 edits by octocat" });
    expect(github.labelled).toEqual([1]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it("pr: deletes the branch when the PR cannot be opened", async () => {
    const user = await signIn();
    github.failPulls = true;
    const response = await submit(user, { edits: [statusEdit()], mode: "pr" });
    expect(response.status).toBe(502);
    const body = await json(response);
    expect(body).toMatchObject({ ok: false, code: "pr_failed" });
    expect(body.error).toContain("branch was removed");
    expect(body.error).not.toContain(TOKEN);
    expect([...github.refs.keys()]).toEqual(["main"]);
    expect(github.refs.get("main")).toBe(github.initialHead);
    expect(github.deleted).toHaveLength(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("pr: a 403 opening the PR removes the branch and asks to reconnect", async () => {
    const user = await signIn();
    github.failPulls = true;
    github.failPullsStatus = 403;
    const response = await submit(user, { edits: [statusEdit()], mode: "pr" });
    expect(response.status).toBe(401);
    const body = await json(response);
    expect(body).toMatchObject({ ok: false, code: "github_auth", needsGithubWrite: true });
    expect([...github.refs.keys()]).toEqual(["main"]);
    expect(github.deleted).toHaveLength(1);
  });

  it("pr: a missing label still succeeds, with a warning", async () => {
    const user = await signIn();
    github.labelExists = false;
    const response = await submit(user, { edits: [statusEdit()], mode: "pr" });
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.ok).toBe(true);
    expect(body.pr).toBeDefined();
    expect(body.warnings).toEqual(['label "snoboard" was not added']);
  });

  it("direct: fast-forwards the branch with the expected old sha and never forces", async () => {
    const user = await signIn();
    const response = await submit(user, { edits: [statusEdit()], mode: "direct" });
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body).toMatchObject({ ok: true, mode: "direct", branch: "main" });
    expect(body.pr).toBeUndefined();
    expect(github.refs.get("main")).toBe(body.commit);
    expect(github.commit(body.commit).parents).toEqual([github.initialHead]);
    expect(github.patches).toEqual([{ branch: "main", sha: body.commit, force: false, applied: true }]);
    expect(github.commit(body.commit).message).toBe(
      "snoboard: 1 edit by octocat\n\nSnoboard-Edit: acme-001: status idea -> planned\nSnoboard-Edit-By: octocat\n",
    );
  });

  it("direct: retries once when the branch moved, re-applying on the new head", async () => {
    const user = await signIn();
    github.beforePatch = (fake) => {
      fake.beforePatch = undefined;
      fake.pushCommit({ [BETA]: betaText.replace("# Beta", "# Beta\n\nAdded upstream.") });
    };
    const response = await submit(user, { edits: [statusEdit()], mode: "direct" });
    expect(response.status).toBe(200);
    const body = await json(response);
    const head = github.refs.get("main") ?? "";
    expect(head).toBe(body.commit);
    expect(github.fileAt(head, BETA)).toContain("Added upstream.");
    expect(github.fileAt(head, ALPHA)).toContain("status: planned");
    expect(github.patches.filter((patch) => patch.applied)).toHaveLength(1);
  });

  it("direct: a push refused by branch protection is direct_rejected and moves nothing", async () => {
    const user = await signIn();
    github.protectedBranches.add("main");
    const response = await submit(user, { edits: [statusEdit()], mode: "direct" });
    expect(response.status).toBe(409);
    const body = await json(response);
    expect(body).toMatchObject({ ok: false, code: "direct_rejected", alternativeMode: "pr" });
    expect(github.refs.get("main")).toBe(github.initialHead);
    expect([...github.refs.keys()]).toEqual(["main"]);

    useEdits({ modes: ["direct"], directBranch: "main" });
    const onlyDirect = await json(await submit(user, { edits: [statusEdit()], mode: "direct" }));
    expect(onlyDirect.code).toBe("direct_rejected");
    expect(onlyDirect.alternativeMode).toBeUndefined();
  });

  it("re-applies an edit when the file changed upstream but the field did not", async () => {
    const user = await signIn();
    github.pushCommit({ [ALPHA]: alphaText.replace("Keep this prose.", "Prose edited upstream.") });
    const response = await submit(user, { edits: [statusEdit()], mode: "direct" });
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.reapplied).toEqual([ALPHA]);
    const text = github.fileAt(body.commit, ALPHA) ?? "";
    expect(text).toContain("Prose edited upstream.");
    expect(text).toContain("status: planned");
  });

  it("rejects the whole batch when one edit's from no longer matches, committing nothing", async () => {
    const user = await signIn();
    const upstream = github.pushCommit({ [ALPHA]: alphaText.replace("status: idea", "status: active") });
    const response = await submit(user, {
      edits: [statusEdit(), { kind: "setPriority", id: "acme-002", from: "p1", to: "p0" }],
      mode: "pr",
    });
    expect(response.status).toBe(409);
    const body = await json(response);
    expect(body.code).toBe("rejected");
    expect(body.results).toEqual([
      { index: 0, ok: false, error: "acme-001: stale", path: ALPHA },
      { index: 1, ok: true, path: BETA },
    ]);
    expect(github.commitCount()).toBe(0);
    expect(github.calls.some((call) => call.method !== "GET")).toBe(false);
    expect(github.refs.get("main")).toBe(upstream);
    expect([...github.refs.keys()]).toEqual(["main"]);
  });

  it("rejects a stale body edit", async () => {
    const user = await signIn();
    github.pushCommit({ [ALPHA]: alphaText.replace("Keep this prose.", "Changed.") });
    const response = await submit(user, {
      edits: [{ kind: "setBody", id: "acme-001", fromHash: bodyHash(alphaText), to: "\n# Alpha\n\nMine.\n" }],
      mode: "direct",
    });
    expect(response.status).toBe(409);
    expect((await json(response)).code).toBe("rejected");
    expect(github.commitCount()).toBe(0);
  });

  it("refuses a mode that is not enabled, before calling GitHub", async () => {
    const user = await signIn();
    useEdits({ modes: ["pr"] });
    const response = await submit(user, { edits: [statusEdit()], mode: "direct" }, await csrfFor(user));
    expect(response.status).toBe(400);
    expect((await json(response)).code).toBe("mode_not_allowed");
    const unknown = await submit(user, { edits: [statusEdit()], mode: "force" }, await csrfFor(user));
    expect(unknown.status).toBe(400);
    expect(github.calls).toHaveLength(0);
  });

  it("refuses a path outside <root>/<project>/<NNN>-<slug>/<file>", async () => {
    const user = await signIn();
    const escaped: Snapshot = {
      ...snapshot,
      items: snapshot.items.map((item) =>
        item.id === "acme-001" ? { ...item, path: "initiatives/acme/001-alpha/../../../.github/workflows/x.yml" } : item,
      ),
    };
    seedStore(escaped, config);
    const response = await submit(user, { edits: [statusEdit()], mode: "pr" });
    expect(response.status).toBe(400);
    expect((await json(response)).code).toBe("path_not_allowed");
    expect(github.calls.filter((call) => call.method !== "GET")).toHaveLength(0);

    for (const bad of [
      "initiatives/acme/001-alpha/other.md",
      "initiatives/acme/001-alpha/sub/initiative.md",
      "initiatives/../acme/001-alpha/initiative.md",
      "docs/acme/001-alpha/initiative.md",
      "initiatives/acme/alpha/initiative.md",
      "initiatives\\acme\\001-alpha\\initiative.md",
      "/initiatives/acme/001-alpha/initiative.md",
    ]) {
      expect(isEditablePath(bad, config), bad).toBe(false);
    }
    expect(isEditablePath(ALPHA, config)).toBe(true);
  });

  it("refuses a symlink or redirected file at the target head", async () => {
    const user = await signIn();
    github.symlinks.add(ALPHA);
    const response = await submit(user, { edits: [statusEdit()], mode: "direct" });
    expect(response.status).toBe(502);
    expect((await json(response)).error).toContain("not a regular file");
    expect(github.commitCount()).toBe(0);
  });

  it("re-checks a new initiative number against the head and open edit branches", async () => {
    const user = await signIn();
    const create = { kind: "createInitiative", project: "acme", slug: "gamma", title: "Gamma", status: "idea", priority: "p2" };
    const branchHead = github.commitOn(github.initialHead, { "initiatives/acme/003-other/initiative.md": "x" });
    github.refs.set("snoboard/edits-20261001-000000-abcd", branchHead);
    const taken = await submit(user, { edits: [create], mode: "pr" });
    expect(taken.status).toBe(409);
    expect((await json(taken)).code).toBe("number_taken");
    expect(github.commitCount()).toBe(0);

    github.refs.delete("snoboard/edits-20261001-000000-abcd");
    const ok = await submit(user, { edits: [create], mode: "pr" });
    expect(ok.status).toBe(200);
    const body = await json(ok);
    expect(github.fileAt(body.commit, "initiatives/acme/003-gamma/initiative.md")).toContain("id: acme-003");
    expect(body.created).toEqual([
      { index: 0, id: "acme-003", number: "003", path: "initiatives/acme/003-gamma/initiative.md" },
    ]);
    expect(github.commit(body.commit).message).toContain("Snoboard-Edit: create acme/gamma: Gamma");
  });

  it("needs a GitHub write token (401 needsGithubWrite)", async () => {
    const user = await signIn({ withToken: false });
    const response = await submit(user, { edits: [statusEdit()], mode: "pr" });
    expect(response.status).toBe(401);
    expect(await json(response)).toMatchObject({ code: "needs_github_write", needsGithubWrite: true });
    expect(github.calls).toHaveLength(0);
  });

  it("drops the token when GitHub no longer accepts it", async () => {
    const user = await signIn();
    github.unauthorized = true;
    const response = await submit(user, { edits: [statusEdit()], mode: "pr" });
    expect(response.status).toBe(401);
    const body = await json(response);
    expect(body).toMatchObject({ code: "github_auth", needsGithubWrite: true });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(writeTokenCount()).toBe(0);
    expect(response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${WRITE_COOKIE}=`))).toContain("Max-Age=0");
  });

  it("keeps the token out of error messages GitHub echoes back", async () => {
    const user = await signIn();
    github.echoTokenOnBlob = true;
    const response = await submit(user, { edits: [statusEdit()], mode: "direct" });
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).not.toContain(TOKEN);
    expect(text).toContain("[redacted]");
    expect(github.refs.get("main")).toBe(github.initialHead);
  });

  it("checks CSRF, origin, identity, and the edit switch", async () => {
    const user = await signIn();
    const missing = await submit(user, { edits: [statusEdit()], mode: "pr" }, null);
    expect(missing.status).toBe(403);
    expect((await json(missing)).code).toBe("csrf");
    const wrong = await submit(user, { edits: [statusEdit()], mode: "pr" }, "A".repeat(43));
    expect(wrong.status).toBe(403);
    const other = await signIn({ sub: "octocat", iat: Date.now() - 10_000 });
    const crossSession = await submit(user, { edits: [statusEdit()], mode: "pr" }, await csrfFor(other));
    expect(crossSession.status).toBe(403);

    const crossSite = await app.request("/api/edits/submit", {
      method: "POST",
      headers: { cookie: user.cookie, origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ edits: [statusEdit()], mode: "pr", csrf: await csrfFor(user) }),
    });
    expect(crossSite.status).toBe(403);

    const anonymous = await app.request("/api/edits/submit", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: "{}",
    });
    expect(anonymous.status).toBe(401);

    const password = await signIn({ method: "password", sub: "reader", withToken: false });
    const readOnly = await submit(password, { edits: [statusEdit()], mode: "pr" }, await csrfFor(password));
    expect(readOnly.status).toBe(403);
    expect((await json(readOnly)).code).toBe("read_only");

    resetEditConfig();
    const disabled = await submit(user, { edits: [statusEdit()], mode: "pr" }, "x");
    expect(disabled.status).toBe(403);
    expect((await json(disabled)).code).toBe("editing_disabled");
    expect(github.calls).toHaveLength(0);
  });

  it("attachments: body and image land in one commit; the image blob is sent as base64", async () => {
    const user = await signIn();
    const body = `${alphaText.slice(alphaText.indexOf("\n---\n") + 5)}\n![shot](assets/shot.png)\n`;
    const edits = [
      { kind: "setBody", id: "acme-001", fromHash: bodyHash(alphaText), to: body },
      imageEdit(PNG_BYTES),
    ];
    const response = await submit(user, { edits, mode: "direct", attachments: imagePayload(PNG_BYTES) });
    const result = await json(response);
    expect(response.status).toBe(200);
    expect(github.commitCount()).toBe(1);
    const commit = github.commit(result.commit);
    const imagePath = "initiatives/acme/001-alpha/assets/shot.png";
    const blob = commit.tree.get(imagePath) ?? "";
    expect(github.blobEncodings.get(blob)).toBe("base64");
    expect(github.blobs.get(blob)).toBe(PNG_BYTES.toString("base64"));
    expect(github.fileAt(result.commit, ALPHA)).toContain("![shot](assets/shot.png)");
    expect(commit.message).toContain(`Snoboard-Edit: acme-001: attach assets/shot.png (${PNG_BYTES.length} B)`);
    const audit = logs.find((line) => line.includes("submit ok")) ?? "";
    expect(audit).toContain(`attachments=1 attachment_bytes=${PNG_BYTES.length}`);
    expect(audit).not.toContain(PNG_BYTES.toString("base64"));
  });

  it("attachments: an image for a new initiative goes inside the new folder", async () => {
    const user = await signIn();
    const edits = [
      { kind: "createInitiative", project: "acme", slug: "gamma", title: "Gamma", status: "idea", priority: "p2" },
      imageEdit(PNG_BYTES, { id: "new:acme/gamma" }),
    ];
    const response = await submit(user, { edits, mode: "direct", attachments: imagePayload(PNG_BYTES) });
    const result = await json(response);
    expect(response.status).toBe(200);
    const tree = github.commit(result.commit).tree;
    expect(tree.has("initiatives/acme/003-gamma/initiative.md")).toBe(true);
    expect(tree.has("initiatives/acme/003-gamma/assets/shot.png")).toBe(true);
  });

  it("attachments: refuses wrong magic bytes, SVG, mismatched data, unused bytes, traversal and existing names", async () => {
    const user = await signIn();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const cases: { edits: unknown[]; attachments: Record<string, string>; error: RegExp }[] = [
      { edits: [imageEdit(svg)], attachments: imagePayload(svg), error: /not a PNG, JPEG, WebP or GIF/ },
      {
        edits: [imageEdit(PNG_BYTES, { contentType: "image/gif", path: "assets/shot.gif" })],
        attachments: imagePayload(PNG_BYTES),
        error: /image\/png, not image\/gif/,
      },
      { edits: [imageEdit(PNG_BYTES, { size: 3 })], attachments: imagePayload(PNG_BYTES), error: /size does not match/ },
      { edits: [imageEdit(PNG_BYTES)], attachments: {}, error: /image data is missing/ },
      { edits: [statusEdit()], attachments: imagePayload(PNG_BYTES), error: /no edit uses/ },
      { edits: [imageEdit(PNG_BYTES, { path: "assets/../../x.png" })], attachments: imagePayload(PNG_BYTES), error: /invalid/ },
      { edits: [imageEdit(PNG_BYTES, { path: "assets/x.svg" })], attachments: imagePayload(PNG_BYTES), error: /invalid/ },
    ];
    for (const entry of cases) {
      resetSubmitState();
      const response = await submit(user, { edits: entry.edits, mode: "direct", attachments: entry.attachments });
      const result = await json(response);
      expect(response.status, JSON.stringify(entry.edits)).toBe(409);
      expect(JSON.stringify(result)).toMatch(entry.error);
    }
    resetSubmitState();
    github.pushCommit({ "initiatives/acme/001-alpha/assets/shot.png": "existing" });
    const taken = await submit(user, { edits: [imageEdit(PNG_BYTES)], mode: "direct", attachments: imagePayload(PNG_BYTES) });
    expect(taken.status).toBe(409);
    expect((await json(taken)).error).toContain("already exists");
    expect(github.commitCount()).toBe(0);
  });

  it("attachments: oversize images and bodies are refused before anything is written", async () => {
    const user = await signIn();
    const big = Buffer.concat([PNG_BYTES, Buffer.alloc(5 * 1024 * 1024)]);
    const oversize = await submit(user, { edits: [imageEdit(big)], mode: "direct", attachments: imagePayload(big) });
    expect(oversize.status).toBe(400);
    expect((await json(oversize)).error).toContain("larger than 5 MB");
    const csrf = await csrfFor(user);
    const huge = await app.request("/api/edits/submit", {
      method: "POST",
      headers: { cookie: user.cookie, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ edits: [statusEdit()], mode: "pr", csrf, attachments: { x: "A".repeat(13 * 1024 * 1024) } }),
    });
    expect(huge.status).toBe(413);
    expect((await json(huge)).code).toBe("too_large");
    expect(github.commitCount()).toBe(0);
  });

  it("allows a batch body above the default limit and rejects one above 64 KiB", async () => {
    const user = await signIn();
    const csrf = await csrfFor(user);
    const big = await app.request("/api/edits/submit", {
      method: "POST",
      headers: { cookie: user.cookie, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ edits: [statusEdit()], mode: "pr", csrf, pad: "a".repeat(20_000) }),
    });
    expect(big.status).toBe(200);
    const huge = await app.request("/api/edits/submit", {
      method: "POST",
      headers: { cookie: user.cookie, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ edits: [statusEdit()], mode: "pr", csrf, pad: "a".repeat(70_000) }),
    });
    expect(huge.status).toBe(413);
  });

  it("rate-limits submits per user per hour", async () => {
    const now = 1_700_000_000_000;
    for (let index = 0; index < SUBMIT_LIMIT_PER_HOUR; index += 1) expect(allowSubmit("a", now)).toBe(true);
    expect(allowSubmit("a", now + 1)).toBe(false);
    expect(allowSubmit("b", now + 1)).toBe(true);
    expect(allowSubmit("a", now + 60 * 60 * 1000 + 1)).toBe(true);

    resetSubmitState();
    const user = await signIn();
    const csrf = await csrfFor(user);
    github.unavailable = true;
    for (let index = 0; index < SUBMIT_LIMIT_PER_HOUR; index += 1) {
      const response = await submit(user, { edits: [statusEdit()], mode: "pr" }, csrf);
      expect(response.status).toBe(502);
    }
    const limited = await submit(user, { edits: [statusEdit()], mode: "pr" }, csrf);
    expect(limited.status).toBe(429);
  });

  it("counts the rate limit per person, so signing in again does not reset it", async () => {
    process.env.SNOBOARD_EDIT_BOT_TOKEN_FILE = await writeTokenFile("bot-synthetic-rate-token");
    useEdits({ modes: ["pr"], botTokenConfigured: true });
    github.bearers.add("bot-synthetic-rate-token");
    github.unavailable = true;
    for (let index = 0; index < SUBMIT_LIMIT_PER_HOUR; index += 1) {
      // A fresh password session every time: a new cookie, a new CSRF token.
      const session = await signIn({ method: "password", sub: "password", iat: Date.now() - index, withToken: false });
      expect((await submit(session, { edits: [statusEdit()], mode: "pr" })).status).toBe(502);
    }
    const again = await signIn({ method: "password", sub: "password", iat: Date.now() - 999, withToken: false });
    expect((await submit(again, { edits: [statusEdit()], mode: "pr" })).status).toBe(429);
    const github1 = await signIn({ sub: "octocat" });
    expect((await submit(github1, { edits: [statusEdit()], mode: "pr" })).status).toBe(502);
  });

  it("logs denied and failed submits at info with user and reason, never content or token", async () => {
    const user = await signIn();
    const secretTitle = "Quarterly plan for the secret-launch";
    const titleEdit = { kind: "setTitle", id: "acme-001", from: "nope", to: secretTitle };
    expect((await submit(user, { edits: [titleEdit], mode: "pr" }, "forged")).status).toBe(403);
    expect((await submit(user, { edits: [titleEdit], mode: "pr" })).status).toBe(409);
    const info = logs.filter((line) => line.startsWith("snoboard: submit"));
    expect(info).toEqual([
      'snoboard: submit denied reason="csrf" user="octocat" actor=github repo="default" mode="pr" edits=1',
      'snoboard: submit failed reason="rejected" user="octocat" actor=github repo="default" mode="pr" edits=1',
    ]);
    expect(logs.join(" ")).not.toContain("secret-launch");
    const ok = await submit(user, { edits: [statusEdit()], mode: "pr" });
    expect(ok.status).toBe(200);
    expect(logs.at(-1)).toBe('snoboard: submit ok reason="ok" user="octocat" actor=github repo="default" mode="pr" edits=1');
  });

  it("password users submit with the bot token and name the person", async () => {
    const bot = "bot-synthetic-edit-token";
    const file = await writeTokenFile(bot);
    process.env.SNOBOARD_EDIT_BOT_TOKEN_FILE = file;
    useEdits({ modes: ["pr", "direct"], directBranch: "main", botTokenConfigured: true });
    github.bearers.add(bot);
    const password = await signIn({ method: "password", sub: "reader", withToken: false });
    const response = await submit(password, { edits: [statusEdit()], mode: "pr" });
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(github.commit(body.commit).message).toContain(`Snoboard-Edit-By: ${PASSWORD_BOT_IDENTITY} (via bot)`);
    expect(github.commit(body.commit).message).not.toContain("reader");
    expect(github.authorizations.every((presented) => presented === bot)).toBe(true);
    expect(JSON.stringify(body)).not.toContain(bot);
    expect(logs.join("\n")).not.toContain(bot);

    process.env.SNOBOARD_PASSWORD_NAME = "Ada Lane";
    const named = await submit(password, { edits: [statusEdit()], mode: "direct" });
    expect(named.status).toBe(200);
    const namedBody = await json(named);
    expect(github.commit(namedBody.commit).message).toContain("Snoboard-Edit-By: Ada Lane (via bot)");
  });

  it("github users keep their own token when a bot token is configured", async () => {
    const bot = "bot-synthetic-other-token";
    process.env.SNOBOARD_EDIT_BOT_TOKEN_FILE = await writeTokenFile(bot);
    useEdits({ modes: ["pr", "direct"], directBranch: "main", botTokenConfigured: true });
    const user = await signIn();
    const response = await submit(user, { edits: [statusEdit()], mode: "direct" });
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(github.commit(body.commit).message).toContain("Snoboard-Edit-By: octocat");
    expect(github.commit(body.commit).message).not.toContain("via bot");
    expect(github.commit(body.commit).message).not.toContain(bot);
    expect(github.authorizations.every((presented) => presented === TOKEN)).toBe(true);
    expect(logs.join("\n")).not.toContain(bot);
  });

  it("writes the audit trailer last, one line per edit", () => {
    const message = commitMessage(
      [
        { kind: "setTitle", id: "acme-001", from: "Alpha", to: "Alpha two" },
        { kind: "setPhaseStatus", id: "acme-001", phase: 2, from: "planned", to: "done" },
      ],
      "octocat",
    );
    const lines = message.trimEnd().split("\n");
    expect(lines.at(-1)).toBe("Snoboard-Edit-By: octocat");
    expect(lines.filter((line) => line.startsWith("Snoboard-Edit: "))).toEqual([
      "Snoboard-Edit: acme-001: title Alpha -> Alpha two",
      "Snoboard-Edit: acme-001: phase 2 status planned -> done",
    ]);
  });
});

describe("submit credentials", () => {
  it("picks a token for each identity and never gives GitHub the bot token", () => {
    const bot = "bot-token";
    const user = { token: "user-token", login: "octocat" };
    expect(chooseSubmitCredential({ actor: "anonymous", writeToken: null, botToken: bot })).toMatchObject({
      ok: false,
      code: "read_only",
    });
    expect(chooseSubmitCredential({ actor: "password", writeToken: null })).toMatchObject({
      ok: false,
      code: "read_only",
    });
    expect(chooseSubmitCredential({ actor: "password", writeToken: user, botToken: bot })).toEqual({
      ok: true,
      token: bot,
      user: `${PASSWORD_BOT_IDENTITY} (via bot)`,
    });
    expect(chooseSubmitCredential({ actor: "password", writeToken: null, botToken: bot, passwordName: "Ada Lane" })).toEqual({
      ok: true,
      token: bot,
      user: "Ada Lane (via bot)",
    });
    expect(passwordIdentity(" \n ")).toBe(PASSWORD_BOT_IDENTITY);
    expect(chooseSubmitCredential({ actor: "cloudflare-access", writeToken: null, botToken: bot })).toMatchObject({
      ok: false,
      code: "read_only",
    });
    expect(
      chooseSubmitCredential({
        actor: "cloudflare-access",
        writeToken: user,
        botToken: bot,
        accessEmail: "Ada@Example.com",
      }),
    ).toEqual({ ok: true, token: bot, user: "Ada@Example.com (via bot)" });
    expect(chooseSubmitCredential({ actor: "github", writeToken: null, botToken: bot })).toMatchObject({
      ok: false,
      code: "needs_github_write",
    });
    expect(chooseSubmitCredential({ actor: "github", writeToken: user, botToken: bot })).toEqual({
      ok: true,
      token: user.token,
      user: "octocat",
    });
  });

  it("reads a single-line bot token file and ignores a missing or multiline file", async () => {
    expect(readBotTokenFile(undefined)).toBeUndefined();
    expect(readBotTokenFile(path.join(os.tmpdir(), "snoboard-missing-bot-token"))).toBeUndefined();
    const dir = await mkdtemp(path.join(os.tmpdir(), "snoboard-bot-"));
    try {
      const file = path.join(dir, "token");
      await writeFile(file, " bot-token \n", "utf8");
      expect(readBotTokenFile(file)).toBe("bot-token");
      await writeFile(file, "one\ntwo\n", "utf8");
      expect(readBotTokenFile(file)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

type User = { claims: SessionClaims; cookie: string };

async function signIn(
  options: { sub?: string; method?: "github" | "password"; iat?: number; withToken?: boolean } = {},
): Promise<User> {
  const iat = options.iat ?? Date.now();
  const claims: SessionClaims = {
    sub: options.sub ?? "octocat",
    method: options.method ?? "github",
    iat,
    exp: iat + 24 * 60 * 60 * 1000,
  };
  let cookie = `${SESSION_COOKIE}=${signSession(secret, claims)}`;
  if (options.withToken !== false) {
    const { handle } = storeWriteToken(secret, claims, TOKEN);
    cookie = `${cookie}; ${WRITE_COOKIE}=${handle}`;
  }
  return { claims, cookie };
}

async function csrfFor(user: User): Promise<string> {
  const response = await app.request("/api/edit-config", { headers: { cookie: user.cookie } });
  const body = (await response.json()) as { csrf?: string };
  return body.csrf ?? "";
}

async function submit(
  user: User,
  payload: { edits: unknown[]; mode: string; attachments?: Record<string, string> },
  csrf?: string | null,
): Promise<Response> {
  const token = csrf === undefined ? await csrfFor(user) : csrf;
  return app.request("/api/edits/submit", {
    method: "POST",
    headers: { cookie: user.cookie, origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ ...payload, ...(token === null ? {} : { csrf: token }) }),
  });
}

function useEdits(partial: Partial<EditSettings>): void {
  setEditConfig({ enabled: true, modes: ["pr"], botTokenConfigured: false, ...partial });
}

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("synthetic image body"),
]);

function imageEdit(bytes: Buffer, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "addAttachment",
    id: "acme-001",
    path: "assets/shot.png",
    contentType: "image/png",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    ...overrides,
  };
}

function imagePayload(bytes: Buffer): Record<string, string> {
  return { [createHash("sha256").update(bytes).digest("hex")]: bytes.toString("base64") };
}

function statusEdit(): Record<string, unknown> {
  return { kind: "setStatus", id: "acme-001", from: "idea", to: "planned" };
}

async function writeTokenFile(token: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "snoboard-bot-"));
  const file = path.join(dir, "token");
  await writeFile(file, `${token}\n`, "utf8");
  return file;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function json(response: Response): Promise<any> {
  return response.json();
}

type FakeCommit = { tree: Map<string, string>; parents: string[]; message: string };

/** Just enough of GitHub's Git Data, contents, pulls and labels API, in memory. */
class FakeGithub {
  readonly refs = new Map<string, string>();
  readonly blobs = new Map<string, string>();
  readonly blobEncodings = new Map<string, string>();
  readonly commits = new Map<string, FakeCommit>();
  readonly trees = new Map<string, Map<string, string>>();
  readonly calls: { method: string; path: string }[] = [];
  readonly bearers = new Set<string>([TOKEN]);
  readonly authorizations: string[] = [];
  readonly pulls: { head: string; base: string; title: string }[] = [];
  readonly labelled: number[] = [];
  readonly deleted: string[] = [];
  readonly patches: { branch: string; sha: string; force: unknown; applied?: boolean }[] = [];
  readonly protectedBranches = new Set<string>();
  readonly symlinks = new Set<string>();
  readonly initialHead: string;
  failPulls = false;
  failPullsStatus = 422;
  labelExists = true;
  unauthorized = false;
  unavailable = false;
  echoTokenOnBlob = false;
  beforePatch: ((fake: FakeGithub) => void) | undefined;
  private created = 0;

  constructor(files: Record<string, string>) {
    const tree = new Map<string, string>();
    for (const [filePath, text] of Object.entries(files)) tree.set(filePath, this.putBlob(text));
    this.initialHead = this.putCommit(tree, [], "seed", false);
    this.refs.set("main", this.initialHead);
  }

  commitCount(): number {
    return this.created;
  }

  commit(sha: string): FakeCommit {
    const commit = this.commits.get(sha);
    if (commit === undefined) throw new Error(`no commit ${sha}`);
    return commit;
  }

  fileAt(sha: string, filePath: string): string | undefined {
    const blob = this.commit(sha).tree.get(filePath);
    return blob === undefined ? undefined : this.blobs.get(blob);
  }

  commitOn(parent: string, files: Record<string, string>): string {
    const tree = new Map(this.commit(parent).tree);
    for (const [filePath, text] of Object.entries(files)) tree.set(filePath, this.putBlob(text));
    return this.putCommit(tree, [parent], "upstream", false);
  }

  /** Someone else pushes to main. */
  pushCommit(files: Record<string, string>): string {
    const sha = this.commitOn(this.refs.get("main") ?? "", files);
    this.refs.set("main", sha);
    return sha;
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const method = init?.method ?? "GET";
    const auth = new Headers(init?.headers).get("authorization");
    const presented = auth !== null && auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
    this.authorizations.push(presented);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const prefix = `/repos/${REPO}`;
    if (url.origin !== "https://api.github.com" || !url.pathname.startsWith(prefix)) return reply(404, {});
    const route = decodeURIComponent(url.pathname.slice(prefix.length));
    this.calls.push({ method, path: route });
    if (!this.bearers.has(presented)) return reply(401, { message: "Bad credentials" });
    if (this.unauthorized) return reply(401, { message: "Bad credentials" });
    if (this.unavailable) return reply(503, { message: "unavailable" });

    if (route.startsWith("/git/refs/heads/")) {
      const branch = route.slice("/git/refs/heads/".length);
      const sha = this.refs.get(branch);
      if (method === "GET") return sha === undefined ? reply(404, {}) : reply(200, { object: { sha } });
      if (method === "DELETE") {
        this.refs.delete(branch);
        this.deleted.push(branch);
        return new Response(null, { status: 204 });
      }
      if (method === "PATCH") {
        const record = { branch, sha: String(body.sha), force: body.force };
        this.patches.push(record);
        this.beforePatch?.(this);
        if (this.protectedBranches.has(branch)) {
          return reply(422, { message: "Protected branch update failed for refs/heads/main." });
        }
        const current = this.refs.get(branch);
        if (current === undefined || !this.descends(String(body.sha), current)) {
          return reply(422, { message: "Update is not a fast forward" });
        }
        this.refs.set(branch, String(body.sha));
        Object.assign(record, { applied: true });
        return reply(200, { object: { sha: body.sha } });
      }
    }
    if (route === "/git/refs" && method === "POST") {
      const name = String(body.ref).replace(/^refs\/heads\//, "");
      if (this.refs.has(name)) return reply(422, { message: "Reference already exists" });
      this.refs.set(name, String(body.sha));
      return reply(201, { ref: body.ref, object: { sha: body.sha } });
    }
    if (route.startsWith("/git/matching-refs/heads/")) {
      const wanted = route.slice("/git/matching-refs/heads/".length);
      return reply(
        200,
        [...this.refs.keys()].filter((name) => name.startsWith(wanted)).map((name) => ({ ref: `refs/heads/${name}` })),
      );
    }
    if (route.startsWith("/git/commits/") && method === "GET") {
      const sha = route.slice("/git/commits/".length);
      const commit = this.commits.get(sha);
      if (commit === undefined) return reply(404, {});
      return reply(200, { sha, tree: { sha: this.treeId(sha) } });
    }
    if (route === "/git/blobs" && method === "POST") {
      if (this.echoTokenOnBlob) return reply(500, { message: `server saw ${TOKEN}` });
      const sha = this.putBlob(String(body.content));
      this.blobEncodings.set(sha, String(body.encoding));
      return reply(201, { sha });
    }
    if (route === "/git/trees" && method === "POST") {
      const base = this.trees.get(String(body.base_tree));
      if (base === undefined) return reply(422, { message: "bad base tree" });
      const tree = new Map(base);
      for (const entry of body.tree as { path: string; sha: string }[]) tree.set(entry.path, entry.sha);
      const id = `tree-${this.trees.size + 1}`;
      this.trees.set(id, tree);
      return reply(201, { sha: id });
    }
    if (route === "/git/commits" && method === "POST") {
      const tree = this.trees.get(String(body.tree));
      if (tree === undefined) return reply(422, { message: "bad tree" });
      return reply(201, { sha: this.putCommit(tree, body.parents as string[], String(body.message), true) });
    }
    if (route.startsWith("/contents/") && method === "GET") {
      const filePath = route.slice("/contents/".length);
      const ref = url.searchParams.get("ref") ?? "main";
      const sha = this.refs.get(ref) ?? ref;
      const commit = this.commits.get(sha);
      if (commit === undefined) return reply(404, {});
      const blob = commit.tree.get(filePath);
      if (blob !== undefined) {
        const text = this.blobs.get(blob) ?? "";
        if (this.symlinks.has(filePath)) {
          return reply(200, { type: "file", path: "elsewhere/target.md", sha: blob, encoding: "base64", content: "" });
        }
        return reply(200, {
          type: "file",
          path: filePath,
          sha: blob,
          encoding: "base64",
          content: Buffer.from(text).toString("base64").replace(/(.{60})/g, "$1\n"),
        });
      }
      const names = new Set<string>();
      for (const key of commit.tree.keys()) {
        if (key.startsWith(`${filePath}/`)) names.add(key.slice(filePath.length + 1).split("/")[0] ?? "");
      }
      if (names.size === 0) return reply(404, { message: "Not Found" });
      return reply(200, [...names].map((name) => ({ name, type: "dir" })));
    }
    if (route === "/pulls" && method === "POST") {
      if (this.failPulls) return reply(this.failPullsStatus, { message: "Validation Failed" });
      this.pulls.push({ head: String(body.head), base: String(body.base), title: String(body.title) });
      const number = this.pulls.length;
      return reply(201, { number, html_url: `https://github.com/${REPO}/pull/${number}` });
    }
    if (route.startsWith("/labels/")) {
      return this.labelExists ? reply(200, { name: "snoboard" }) : reply(404, { message: "Not Found" });
    }
    const labels = /^\/issues\/(\d+)\/labels$/.exec(route);
    if (labels !== null && method === "POST") {
      this.labelled.push(Number(labels[1]));
      return reply(200, [{ name: "snoboard" }]);
    }
    return reply(404, { message: `unhandled ${method} ${route}` });
  };

  private descends(sha: string, ancestor: string): boolean {
    const queue = [sha];
    while (queue.length > 0) {
      const next = queue.shift() ?? "";
      if (next === ancestor) return true;
      queue.push(...(this.commits.get(next)?.parents ?? []));
    }
    return false;
  }

  private treeId(commitSha: string): string {
    const tree = this.commit(commitSha).tree;
    for (const [id, candidate] of this.trees) if (candidate === tree) return id;
    const id = `tree-${this.trees.size + 1}`;
    this.trees.set(id, tree);
    return id;
  }

  private putBlob(text: string): string {
    const sha = createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0${text}`).digest("hex");
    this.blobs.set(sha, text);
    return sha;
  }

  private putCommit(tree: Map<string, string>, parents: string[], message: string, counted: boolean): string {
    const sha = createHash("sha1").update(`${message}\n${parents.join(",")}\n${this.commits.size}\n${Math.random()}`).digest("hex");
    this.commits.set(sha, { tree, parents, message });
    if (counted) this.created += 1;
    return sha;
  }
}

function reply(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

describe("Cloudflare Access users connect GitHub at submit", () => {
  const signing = makeAccessKey("key-a");
  let github: FakeGithub;
  let githubLogin = "octocat";

  beforeEach(() => {
    logs.length = 0;
    for (const level of ["info", "warn", "error", "log"] as const) {
      vi.spyOn(console, level).mockImplementation((...args) => void logs.push(args.map(String).join(" ")));
    }
    useAccess();
    useEdits({ modes: ["pr", "direct"], directBranch: "main" });
    seedStore(snapshot, config);
    setInitiativeRepoDir(repoDir);
    github = new FakeGithub({ [ALPHA]: alphaText, [BETA]: betaText });
    githubLogin = "octocat";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://example.cloudflareaccess.com/cdn-cgi/access/certs") return reply(200, { keys: [signing.jwk] });
      if (url === "https://github.com/login/oauth/access_token") {
        return reply(200, { access_token: TOKEN, token_type: "bearer", scope: "repo" });
      }
      if (url === "https://api.github.com/user") {
        const auth = new Headers(init?.headers).get("authorization");
        return auth === `Bearer ${TOKEN}` ? reply(200, { login: githubLogin }) : reply(401, { message: "Bad credentials" });
      }
      return github.fetch(input, init);
    });
  });

  afterEach(() => {
    expect(logs.join("\n")).not.toContain(TOKEN);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetAuthConfig();
    resetEditConfig();
    resetStore();
    resetWriteTokens();
    resetSubmitState();
    setInitiativeRepoDir(undefined);
    delete process.env.SNOBOARD_EDIT_BOT_TOKEN_FILE;
  });

  it("start, callback, edit-config, then submit with the own token and both names in the trailer", async () => {
    const ada = accessUser("ada@example.com");
    const before = await json(await app.request("/api/edit-config", { headers: ada.headers }));
    expect(before).toMatchObject({ canSubmit: true, needsGithubWrite: true, githubWriteConnect: true });
    expect(before.githubLogin).toBeUndefined();

    const cookie = await connect(ada);
    const headers = { ...ada.headers, cookie };
    const after = await json(await app.request("/api/edit-config", { headers }));
    expect(after).toMatchObject({ canSubmit: true, needsGithubWrite: false, githubLogin: "octocat" });
    expect(JSON.stringify(after)).not.toContain(TOKEN);

    const response = await accessSubmit(headers, after.csrf, { edits: [statusEdit()], mode: "direct" });
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(github.commit(body.commit).message).toContain("Snoboard-Edit-By: octocat (ada@example.com)");
    expect(github.commit(body.commit).message).not.toContain("via bot");
    expect(github.authorizations.every((presented) => presented === TOKEN)).toBe(true);
    expect(logs.at(-1)).toBe(
      'snoboard: submit ok reason="ok" user="ada@example.com" actor=cloudflare-access github="octocat" repo="default" mode="direct" edits=1',
    );
  });

  it("prefers the connected token over the bot, and the bot otherwise", async () => {
    const bot = "bot-synthetic-access-token";
    process.env.SNOBOARD_EDIT_BOT_TOKEN_FILE = await writeTokenFile(bot);
    useEdits({ modes: ["pr", "direct"], directBranch: "main", botTokenConfigured: true });
    github.bearers.add(bot);
    const ada = accessUser("ada@example.com");
    const plain = await json(await app.request("/api/edit-config", { headers: ada.headers }));
    expect(plain).toMatchObject({ canSubmit: true, needsGithubWrite: false, githubWriteConnect: true });
    const viaBot = await accessSubmit(ada.headers, plain.csrf, { edits: [statusEdit()], mode: "direct" });
    expect(viaBot.status).toBe(200);
    expect(github.commit((await json(viaBot)).commit).message).toContain("Snoboard-Edit-By: ada@example.com (via bot)");

    const headers = { ...ada.headers, cookie: await connect(ada) };
    const own = await accessSubmit(headers, plain.csrf, {
      edits: [{ kind: "setPriority", id: "acme-002", from: "p1", to: "p0" }],
      mode: "direct",
    });
    expect(own.status).toBe(200);
    expect(github.commit((await json(own)).commit).message).toContain("Snoboard-Edit-By: octocat (ada@example.com)");
    expect(logs.join("\n")).not.toContain(bot);
  });

  it("enforces SNOBOARD_ALLOWED_GITHUB_LOGINS when it is set", async () => {
    useAccess(["hubot"]);
    const ada = accessUser("ada@example.com");
    const started = await startConnect(ada);
    const callback = await app.request(`/auth/github/callback?code=c&state=${started.state}`, {
      headers: { ...ada.headers, cookie: `${OAUTH_COOKIE}=${started.cookie}` },
    });
    expect(callback.status).toBe(403);
    expect(await callback.text()).toContain("not allowed");
    expect(writeTokenCount()).toBe(0);

    githubLogin = "hubot";
    const allowed = await connect(ada);
    expect(allowed).toContain(WRITE_COOKIE);
    expect(writeTokenCount()).toBe(1);
  });

  it("stays read-only without the OAuth client, and offers no write flow", async () => {
    setAuthConfig({ modes: ["cloudflare-access"], cloudflareAccess: ACCESS });
    const ada = accessUser("ada@example.com");
    const plain = await json(await app.request("/api/edit-config", { headers: ada.headers }));
    expect(plain).toMatchObject({ canSubmit: false, needsGithubWrite: false });
    expect(plain.githubWriteConnect).toBeUndefined();
    expect((await app.request("/auth/github/write", { headers: ada.headers })).status).toBe(404);
    expect((await app.request("/auth/github/callback?code=c&state=x", { headers: ada.headers })).status).toBe(404);
    // GitHub sign-in itself is never offered on an Access board, even with write-connect on.
    useAccess();
    expect((await app.request("/auth/github", { headers: ada.headers })).status).toBe(404);
  });

  it("keeps tokens apart between Access logins and refuses a callback from another login", async () => {
    const ada = accessUser("ada@example.com");
    const cookie = await connect(ada);
    // Same handle cookie, another person: no token.
    const bob = accessUser("bob@example.com");
    const asBob = await json(await app.request("/api/edit-config", { headers: { ...bob.headers, cookie } }));
    expect(asBob).toMatchObject({ needsGithubWrite: true });
    expect(asBob.githubLogin).toBeUndefined();
    // Ada signs out of Access and back in: a new Access token, so the old write token is unreachable.
    const again = accessUser("ada@example.com", Math.floor(Date.now() / 1000) - 120);
    const relogged = await json(await app.request("/api/edit-config", { headers: { ...again.headers, cookie } }));
    expect(relogged).toMatchObject({ needsGithubWrite: true });

    // A flow started by Ada cannot be finished by Bob.
    const started = await startConnect(ada);
    const swapped = await app.request(`/auth/github/callback?code=c&state=${started.state}`, {
      headers: { ...bob.headers, cookie: `${OAUTH_COOKIE}=${started.cookie}` },
    });
    expect(swapped.status).toBe(403);
    // Without an Access token the write flow does not start.
    expect((await app.request("/auth/github/write")).status).toBe(403);
  });

  it("drops the token on DELETE /auth/github/write (Access sign-out) and when GitHub rejects it", async () => {
    const ada = accessUser("ada@example.com");
    const cookie = await connect(ada);
    const cleared = await app.request("/auth/github/write", {
      method: "DELETE",
      headers: { ...ada.headers, cookie, origin: ORIGIN },
    });
    expect(cleared.status).toBe(204);
    expect(writeTokenCount()).toBe(0);
    const plain = await json(await app.request("/api/edit-config", { headers: { ...ada.headers, cookie } }));
    expect(plain).toMatchObject({ needsGithubWrite: true });

    const again = { ...ada.headers, cookie: await connect(ada) };
    const fresh = await json(await app.request("/api/edit-config", { headers: again }));
    github.unauthorized = true;
    const rejected = await accessSubmit(again, fresh.csrf, { edits: [statusEdit()], mode: "direct" });
    expect(rejected.status).toBe(401);
    expect(await json(rejected)).toMatchObject({ needsGithubWrite: true });
    expect(writeTokenCount()).toBe(0);
  });

  function useAccess(allowedLogins: string[] = []): void {
    setAuthConfig({
      modes: ["cloudflare-access"],
      cloudflareAccess: ACCESS,
      publicUrl: ORIGIN,
      sessionSecret: secret,
      githubWriteConnect: true,
      github: { clientId: "client-id", clientSecret: "client-secret", allowedLogins, allowedOrgs: [] },
    });
  }

  function accessUser(email: string, iat = Math.floor(Date.now() / 1000)): { headers: Record<string, string> } {
    return { headers: { "cf-access-jwt-assertion": signAccessToken(signing, email, iat) } };
  }

  async function startConnect(user: { headers: Record<string, string> }): Promise<{ cookie: string; state: string }> {
    const response = await app.request("/auth/github/write?return=/", { headers: user.headers });
    expect(response.status).toBe(302);
    const header = response.headers.getSetCookie().find((value) => value.startsWith(`${OAUTH_COOKIE}=`)) ?? "";
    const cookie = header.split(";")[0]?.slice(OAUTH_COOKIE.length + 1) ?? "";
    return { cookie, state: openOAuthPending(secret, cookie, Date.now())?.state ?? "" };
  }

  /** Runs the whole write-connect flow and returns the handle cookie. */
  async function connect(user: { headers: Record<string, string> }): Promise<string> {
    const started = await startConnect(user);
    const callback = await app.request(`/auth/github/callback?code=c&state=${started.state}`, {
      headers: { ...user.headers, cookie: `${OAUTH_COOKIE}=${started.cookie}` },
    });
    expect(callback.status).toBe(302);
    const set = callback.headers.getSetCookie();
    expect(set.join("\n")).not.toContain(TOKEN);
    expect(set.some((value) => value.startsWith(`${SESSION_COOKIE}=`))).toBe(false);
    return (set.find((value) => value.startsWith(`${WRITE_COOKIE}=`)) ?? "").split(";")[0] ?? "";
  }

  function accessSubmit(
    headers: Record<string, string>,
    csrf: string,
    payload: { edits: unknown[]; mode: string },
  ): Promise<Response> {
    return app.request("/api/edits/submit", {
      method: "POST",
      headers: { ...headers, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ ...payload, csrf }),
    });
  }
});

const ACCESS = {
  teamDomain: "example.cloudflareaccess.com",
  audiences: ["audience-tag"],
  allowedEmails: [],
  allowedEmailDomains: ["example.com"],
  allowedGroups: [],
};

function makeAccessKey(kid: string): { kid: string; privateKey: KeyObject; jwk: JsonWebKey & { kid: string } } {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const exported = publicKey.export({ format: "jwk" });
  return {
    kid,
    privateKey,
    jwk: { kty: "RSA", n: String(exported.n), e: String(exported.e), kid, alg: "RS256", use: "sig" },
  };
}

function signAccessToken(pair: { kid: string; privateKey: KeyObject }, email: string, iat: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: pair.kid, typ: "JWT" })).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({
      aud: ["audience-tag"],
      iss: "https://example.cloudflareaccess.com",
      iat,
      exp: iat + 24 * 3600,
      nbf: iat - 30,
      email,
      sub: `user-${email.replace("@", "-")}`,
    }),
  ).toString("base64url");
  const input = `${header}.${body}`;
  return `${input}.${createSign("RSA-SHA256").update(input).end().sign(pair.privateKey).toString("base64url")}`;
}
