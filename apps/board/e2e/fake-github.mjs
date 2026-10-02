// End-to-end only. Preloaded with `node --import` by start-server.mjs; the
// production server has no switch for this. It answers the GitHub REST calls
// the edit submit makes (refs, contents, blobs, trees, commits, pulls, labels)
// from the local bare demo remote, so a submit really lands on a branch the
// board then fetches. Anything else still goes to the real fetch.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const bare = process.env.SNOBOARD_E2E_FAKE_GITHUB_DIR;
const repo = process.env.SNOBOARD_E2E_FAKE_GITHUB_REPO ?? "owner/name";
const prefix = `/repos/${repo}`;
const realFetch = globalThis.fetch;
const pulls = [];

function git(args, options = {}) {
  return execFileSync("git", ["--git-dir", bare, ...args], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    ...options,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Snoboard E2E",
      GIT_AUTHOR_EMAIL: "e2e@example.com",
      GIT_COMMITTER_NAME: "Snoboard E2E",
      GIT_COMMITTER_EMAIL: "e2e@example.com",
      ...options.env,
    },
  });
}

function tryGit(args, options) {
  try {
    return git(args, options).trim();
  } catch {
    return null;
  }
}

function reply(status, body) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function refBody(name, sha) {
  return { ref: `refs/heads/${name}`, object: { sha, type: "commit" } };
}

function handle(method, route, query, body) {
  if (route.startsWith("/git/refs/heads/")) {
    const name = route.slice("/git/refs/heads/".length);
    const sha = tryGit(["rev-parse", "--verify", "--quiet", `refs/heads/${name}^{commit}`]);
    if (method === "GET") return sha === null ? reply(404, { message: "Not Found" }) : reply(200, refBody(name, sha));
    if (method === "PATCH") {
      if (sha === null) return reply(422, { message: "Reference does not exist" });
      if (body.force !== false) return reply(422, { message: "e2e fake refuses force" });
      if (tryGit(["merge-base", "--is-ancestor", sha, body.sha]) === null) {
        return reply(422, { message: "Update is not a fast forward" });
      }
      git(["update-ref", `refs/heads/${name}`, body.sha, sha]);
      return reply(200, refBody(name, body.sha));
    }
    if (method === "DELETE") {
      if (sha === null) return reply(422, { message: "Reference does not exist" });
      git(["update-ref", "-d", `refs/heads/${name}`]);
      return reply(204);
    }
  }
  if (method === "GET" && route.startsWith("/git/matching-refs/heads/")) {
    const start = route.slice("/git/matching-refs/heads/".length);
    const out = git(["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads/"]);
    const refs = out
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => line.split(" "))
      .filter(([, ref]) => ref.startsWith(`refs/heads/${start}`))
      .map(([sha, ref]) => ({ ref, object: { sha, type: "commit" } }));
    return reply(200, refs);
  }
  if (method === "POST" && route === "/git/refs") {
    const name = String(body.ref);
    if (tryGit(["rev-parse", "--verify", "--quiet", name]) !== null) return reply(422, { message: "Reference already exists" });
    git(["update-ref", name, body.sha, ""]);
    return reply(201, { ref: name, object: { sha: body.sha, type: "commit" } });
  }
  if (method === "GET" && route.startsWith("/git/commits/")) {
    const sha = route.slice("/git/commits/".length);
    const tree = tryGit(["rev-parse", "--verify", "--quiet", `${sha}^{tree}`]);
    return tree === null ? reply(404, { message: "Not Found" }) : reply(200, { sha, tree: { sha: tree } });
  }
  if (method === "GET" && route.startsWith("/contents/")) {
    const file = route.slice("/contents/".length);
    const ref = query.get("ref") ?? "main";
    const type = tryGit(["cat-file", "-t", `${ref}:${file}`]);
    if (type === null) return reply(404, { message: "Not Found" });
    if (type === "tree") {
      const names = git(["ls-tree", "--name-only", `${ref}:${file}`]).split("\n").filter((name) => name.length > 0);
      return reply(200, names.map((name) => ({ name, path: `${file}/${name}`, type: "dir" })));
    }
    const sha = git(["rev-parse", `${ref}:${file}`]).trim();
    const text = git(["cat-file", "blob", sha]);
    return reply(200, {
      type: "file",
      path: file,
      sha,
      encoding: "base64",
      content: Buffer.from(text, "utf8").toString("base64"),
    });
  }
  if (method === "POST" && route === "/git/blobs") {
    const sha = git(["hash-object", "-w", "--stdin"], { input: String(body.content) }).trim();
    return reply(201, { sha });
  }
  if (method === "POST" && route === "/git/trees") {
    const dir = mkdtempSync(path.join(os.tmpdir(), "snoboard-e2e-index-"));
    const env = { GIT_INDEX_FILE: path.join(dir, "index") };
    try {
      git(["read-tree", String(body.base_tree)], { env });
      for (const entry of body.tree) {
        git(["update-index", "--add", "--cacheinfo", `${entry.mode},${entry.sha},${entry.path}`], { env });
      }
      return reply(201, { sha: git(["write-tree"], { env }).trim() });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  if (method === "POST" && route === "/git/commits") {
    const parents = body.parents.flatMap((parent) => ["-p", parent]);
    const sha = git(["commit-tree", body.tree, ...parents, "-F", "-"], { input: String(body.message) }).trim();
    return reply(201, { sha });
  }
  if (method === "POST" && route === "/pulls") {
    const number = 100 + pulls.length;
    pulls.push({ number, head: body.head, base: body.base });
    return reply(201, { number, html_url: `https://github.com/${repo}/pull/${number}` });
  }
  if (method === "GET" && route === "/pulls") {
    const head = query.get("head") ?? "";
    const match = pulls.filter((pull) => head.endsWith(`:${pull.head}`));
    return reply(200, match.map((pull) => ({ number: pull.number, html_url: `https://github.com/${repo}/pull/${pull.number}` })));
  }
  if (method === "GET" && route.startsWith("/labels/")) return reply(404, { message: "Not Found" });
  return reply(404, { message: `e2e fake: no route for ${method} ${route}` });
}

if (bare !== undefined && bare.length > 0) {
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== "https://api.github.com" || !url.pathname.startsWith(`${prefix}/`)) {
      return realFetch(input, init);
    }
    const method = (init?.method ?? "GET").toUpperCase();
    const route = decodeURIComponent(url.pathname.slice(prefix.length));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    return handle(method, route, url.searchParams, body);
  };
}
