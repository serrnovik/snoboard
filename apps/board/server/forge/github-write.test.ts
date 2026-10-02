import { describe, expect, it, vi } from "vitest";
import {
  addLabelBestEffort,
  commitFiles,
  createBranch,
  deleteBranch,
  getFileBlobSha,
  getFileEntry,
  getFileText,
  getRef,
  GITHUB_WRITE_TIMEOUT_MS,
  GitHubWriteError,
  listBranches,
  listDirectory,
  openPullRequest,
  updateBranch,
  type GitHubCallOptions,
} from "./github-write.js";

const repo = "acme/widgets";
const token = "super-secret-token";
const base = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const tree = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const blobOne = "cccccccccccccccccccccccccccccccccccccccc";
const blobTwo = "dddddddddddddddddddddddddddddddddddddddd";
const newTree = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const commit = "ffffffffffffffffffffffffffffffffffffffff";
const branch = "snoboard/edits-20261001-120000-ab12";
const message = "snoboard: 2 edits by ada\n\nSnoboard-Edit: acme-001: status idea -> review\n";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function callsOf(fetchImpl: ReturnType<typeof vi.fn>): { url: string; init: RequestInit }[] {
  return fetchImpl.mock.calls.map((call) => ({
    url: String(call[0]),
    init: (call[1] ?? {}) as RequestInit,
  }));
}

function bodyOf(init: RequestInit): unknown {
  if (typeof init.body !== "string") return undefined;
  return JSON.parse(init.body) as unknown;
}

describe("GitHub write client", () => {
  it("commits files and opens a pull request without force-updating", async () => {
    expect(GITHUB_WRITE_TIMEOUT_MS).toBe(10_000);
    const blobShas = [blobOne, blobTwo];
    let blobs = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === `https://api.github.com/repos/${repo}/git/refs/heads/main` && method === "GET") {
        return jsonResponse({ object: { type: "commit", sha: base } });
      }
      if (url === `https://api.github.com/repos/${repo}/contents/initiatives/acme/001-alpha/initiative.md?ref=main`) {
        return jsonResponse({
          type: "file",
          sha: blobOne,
          encoding: "base64",
          content: "aGVs\nbG8K",
        });
      }
      if (url === `https://api.github.com/repos/${repo}/git/commits/${base}` && method === "GET") {
        return jsonResponse({ sha: base, tree: { sha: tree } });
      }
      if (url === `https://api.github.com/repos/${repo}/git/blobs` && method === "POST") {
        const sha = blobShas[blobs] ?? blobOne;
        blobs += 1;
        return jsonResponse({ sha });
      }
      if (url === `https://api.github.com/repos/${repo}/git/trees` && method === "POST") {
        return jsonResponse({ sha: newTree });
      }
      if (url === `https://api.github.com/repos/${repo}/git/commits` && method === "POST") {
        return jsonResponse({ sha: commit });
      }
      if (url === `https://api.github.com/repos/${repo}/git/refs` && method === "POST") {
        return jsonResponse({ ref: `refs/heads/${branch}`, object: { sha: commit } });
      }
      if (url === `https://api.github.com/repos/${repo}/pulls` && method === "POST") {
        return jsonResponse({ number: 12, html_url: `https://github.com/${repo}/pull/12` });
      }
      if (url === `https://api.github.com/repos/${repo}/labels/snoboard` && method === "GET") {
        return jsonResponse({ name: "snoboard" });
      }
      if (url === `https://api.github.com/repos/${repo}/issues/12/labels` && method === "POST") {
        return jsonResponse([{ name: "snoboard" }]);
      }
      return jsonResponse({ message: `unexpected ${method} ${url}` }, 500);
    });
    const options: GitHubCallOptions = { fetchImpl };

    const ref = await getRef(repo, "main", token, options);
    expect(ref).toEqual({ sha: base });
    await expect(getFileBlobSha(repo, "main", "initiatives/acme/001-alpha/initiative.md", token, options)).resolves.toBe(blobOne);
    await expect(getFileText(repo, "main", "initiatives/acme/001-alpha/initiative.md", token, options)).resolves.toBe("hello\n");

    const sha = await commitFiles(
      {
        repo,
        token,
        baseSha: base,
        files: [
          { path: "initiatives/acme/001-alpha/initiative.md", text: "status: review\n" },
          { path: "initiatives/acme/007-next/initiative.md", text: "id: acme-007\n" },
        ],
        message,
      },
      options,
    );
    expect(sha).toBe(commit);
    await createBranch(repo, branch, sha, token, options);
    const pull = await openPullRequest(
      {
        repo,
        head: branch,
        base: "main",
        title: "snoboard edits",
        body: message,
        token,
      },
      options,
    );
    expect(pull).toEqual({ number: 12, url: `https://github.com/${repo}/pull/12` });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await addLabelBestEffort(repo, pull.number, "snoboard", token, options);
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }

    const calls = callsOf(fetchImpl);
    expect(calls.map((call) => `${call.init.method ?? "GET"} ${call.url}`)).toEqual([
      `GET https://api.github.com/repos/${repo}/git/refs/heads/main`,
      `GET https://api.github.com/repos/${repo}/contents/initiatives/acme/001-alpha/initiative.md?ref=main`,
      `GET https://api.github.com/repos/${repo}/contents/initiatives/acme/001-alpha/initiative.md?ref=main`,
      `GET https://api.github.com/repos/${repo}/git/commits/${base}`,
      `POST https://api.github.com/repos/${repo}/git/blobs`,
      `POST https://api.github.com/repos/${repo}/git/blobs`,
      `POST https://api.github.com/repos/${repo}/git/trees`,
      `POST https://api.github.com/repos/${repo}/git/commits`,
      `POST https://api.github.com/repos/${repo}/git/refs`,
      `POST https://api.github.com/repos/${repo}/pulls`,
      `GET https://api.github.com/repos/${repo}/labels/snoboard`,
      `POST https://api.github.com/repos/${repo}/issues/12/labels`,
    ]);
    for (const call of calls) {
      expect(call.init.redirect).toBe("error");
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(call.init.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${token}`);
      expect(headers.get("user-agent")).toBe("snoboard");
      expect(headers.get("accept")).toBe("application/vnd.github+json");
    }
    expect(bodyOf(calls[4]!.init)).toEqual({ content: "status: review\n", encoding: "utf-8" });
    expect(bodyOf(calls[5]!.init)).toEqual({ content: "id: acme-007\n", encoding: "utf-8" });
    expect(bodyOf(calls[6]!.init)).toEqual({
      base_tree: tree,
      tree: [
        {
          path: "initiatives/acme/001-alpha/initiative.md",
          mode: "100644",
          type: "blob",
          sha: blobOne,
        },
        {
          path: "initiatives/acme/007-next/initiative.md",
          mode: "100644",
          type: "blob",
          sha: blobTwo,
        },
      ],
    });
    expect(bodyOf(calls[7]!.init)).toEqual({ message, tree: newTree, parents: [base] });
    expect(bodyOf(calls[8]!.init)).toEqual({ ref: `refs/heads/${branch}`, sha: commit });
    expect(bodyOf(calls[9]!.init)).toEqual({
      title: "snoboard edits",
      head: branch,
      base: "main",
      body: message,
    });
    expect(bodyOf(calls[11]!.init)).toEqual({ labels: ["snoboard"] });
    for (const call of calls) {
      const encoded = typeof call.init.body === "string" ? call.init.body : "";
      expect(encoded).not.toContain('"force":true');
      expect(encoded).not.toContain('"force": true');
    }
  });

  it("fast-forwards a branch only when the tip is still the expected sha", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") return jsonResponse({ object: { sha: base } });
      return jsonResponse({ object: { sha: commit } });
    });
    await updateBranch(repo, "main", commit, base, token, { fetchImpl });
    const calls = callsOf(fetchImpl);
    expect(calls[1]?.init.method).toBe("PATCH");
    expect(bodyOf(calls[1]!.init)).toEqual({ sha: commit, force: false });

    const moved = vi.fn(async () => jsonResponse({ object: { sha: commit } }));
    await expect(updateBranch(repo, "main", commit, base, token, { fetchImpl: moved })).rejects.toThrow(
      "branch moved",
    );
    expect(callsOf(moved).map((call) => call.init.method ?? "GET")).toEqual(["GET"]);
  });

  it("parses successful responses larger than a few KB", async () => {
    const refs = Array.from({ length: 200 }, (_, i) => ({ ref: `refs/heads/snoboard/edits-${i}`, object: { sha: "a".repeat(40) } }));
    const fetchImpl = vi.fn(async () => jsonResponse(refs));
    expect(JSON.stringify(refs).length).toBeGreaterThan(4096);
    const names = await listBranches(repo, "snoboard/edits-", token, { fetchImpl });
    expect(names).toHaveLength(200);
  });

  it("never passes a non-https pull request URL through", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ number: 7, html_url: "javascript:alert(1)" }, 201));
    const pull = await openPullRequest(
      { repo, head: "topic", base: "main", title: "t", body: "b", token },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(pull).toEqual({ number: 7, url: `https://github.com/${repo}/pull/7` });
  });

  it("deletes a branch with no body", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await deleteBranch(repo, branch, token, { fetchImpl });
    const calls = callsOf(fetchImpl);
    expect(calls[0]?.url).toBe(`https://api.github.com/repos/${repo}/git/refs/heads/snoboard/edits-20261001-120000-ab12`);
    expect(calls[0]?.init.method).toBe("DELETE");
    expect(calls[0]?.init.body).toBeUndefined();
  });

  it("skips a missing label and swallows later label errors without the token", async () => {
    const missing = vi.fn(async () => jsonResponse({ message: `missing ${token}` }, 404));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await addLabelBestEffort(repo, 12, "snoboard", token, { fetchImpl: missing });
      expect(callsOf(missing)).toHaveLength(1);
      expect(logged).not.toHaveBeenCalled();

      const denied = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method === "GET") return jsonResponse({ name: "snoboard" });
        return jsonResponse({ message: `nope ${token}` }, 401);
      });
      await addLabelBestEffort(repo, 12, "snoboard", token, { fetchImpl: denied });
      expect(logged).toHaveBeenCalledTimes(1);
      const line = String(logged.mock.calls[0]?.[0]);
      expect(line).not.toContain(token);
      expect(line).toContain("401");
    } finally {
      logged.mockRestore();
    }
  });

  it.each([401, 404, 409, 422])("reports HTTP %s without the token", async (status) => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: `nope ${token}` }, status));
    const options = { fetchImpl };
    const calls: [string, () => Promise<unknown>][] = [
      ["getRef", () => getRef(repo, "main", token, options)],
      ["getFileBlobSha", () => getFileBlobSha(repo, "main", "initiative.md", token, options)],
      ["getFileText", () => getFileText(repo, "main", "initiative.md", token, options)],
      ["commitFiles", () => commitFiles({ repo, token, baseSha: base, files: [{ path: "a.md", text: "a" }], message: "m" }, options)],
      ["createBranch", () => createBranch(repo, "topic", commit, token, options)],
      ["updateBranch", () => updateBranch(repo, "main", commit, base, token, options)],
      ["deleteBranch", () => deleteBranch(repo, "topic", token, options)],
      ["openPullRequest", () => openPullRequest({ repo, head: "topic", base: "main", title: "t", body: "b", token }, options)],
    ];
    for (const [name, call] of calls) {
      try {
        await call();
        throw new Error(`${name} should have failed with ${status}`);
      } catch (error) {
        expect(error, name).toBeInstanceOf(GitHubWriteError);
        const message = error instanceof Error ? error.message : "";
        expect(message, name).not.toContain(token);
        if (name === "updateBranch" && status === 422) {
          expect(message, name).toBe("branch moved");
        } else if (status === 409) {
          expect(message, name).toContain("409");
          expect(message, name).toContain("[redacted]");
        } else {
          expect(message, name).toContain(String(status));
        }
      }
    }
  });

  it("times out each call", async () => {
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === undefined) return;
        const onAbort = () => {
          reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    });
    const options = { fetchImpl, timeoutMs: 20 };
    const calls = [
      () => getRef(repo, "main", token, options),
      () => getFileBlobSha(repo, "main", "initiative.md", token, options),
      () => getFileText(repo, "main", "initiative.md", token, options),
      () => commitFiles({ repo, token, baseSha: base, files: [{ path: "a.md", text: "a" }], message: "m" }, options),
      () => createBranch(repo, "topic", commit, token, options),
      () => updateBranch(repo, "main", commit, base, token, options),
      () => deleteBranch(repo, "topic", token, options),
      () => openPullRequest({ repo, head: "topic", base: "main", title: "t", body: "b", token }, options),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toThrow("GitHub request timed out");
    }
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await addLabelBestEffort(repo, 4, "snoboard", token, options);
      expect(logged).toHaveBeenCalled();
      expect(String(logged.mock.calls[0]?.[0])).not.toContain(token);
    } finally {
      logged.mockRestore();
    }
  });
});

describe("GitHub write client (submit helpers)", () => {
  it("tells a refused update (tip unchanged) from a moved branch", async () => {
    const refused = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") return jsonResponse({ object: { sha: base } });
      return jsonResponse({ message: `Protected branch update failed ${token}` }, 422);
    });
    const error = await updateBranch(repo, "main", commit, base, token, { fetchImpl: refused }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitHubWriteError);
    expect((error as GitHubWriteError).code).toBe("rejected");
    expect((error as GitHubWriteError).message).not.toContain(token);
    expect(callsOf(refused).map((call) => call.init.method ?? "GET")).toEqual(["GET", "PATCH", "GET"]);

    let reads = 0;
    const moved = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        reads += 1;
        return jsonResponse({ object: { sha: reads === 1 ? base : tree } });
      }
      return jsonResponse({ message: "Update is not a fast forward" }, 422);
    });
    const movedError = await updateBranch(repo, "main", commit, base, token, { fetchImpl: moved }).catch((caught: unknown) => caught);
    expect((movedError as GitHubWriteError).code).toBe("branch_moved");
  });

  it("reads only regular files at the requested path", async () => {
    const file = vi.fn(async () =>
      jsonResponse({ type: "file", path: "a/b.md", sha: blobOne, encoding: "base64", content: Buffer.from("hi").toString("base64") }),
    );
    await expect(getFileEntry(repo, base, "a/b.md", token, { fetchImpl: file })).resolves.toEqual({ sha: blobOne, text: "hi" });
    const missing = vi.fn(async () => jsonResponse({ message: "Not Found" }, 404));
    await expect(getFileEntry(repo, base, "a/b.md", token, { fetchImpl: missing })).resolves.toBeNull();
    const followed = vi.fn(async () =>
      jsonResponse({ type: "file", path: "elsewhere.md", sha: blobOne, encoding: "base64", content: "" }),
    );
    await expect(getFileEntry(repo, base, "a/b.md", token, { fetchImpl: followed })).rejects.toThrow("not a regular file");
    const symlink = vi.fn(async () => jsonResponse({ type: "symlink", path: "a/b.md", sha: blobOne, target: "x" }));
    await expect(getFileEntry(repo, base, "a/b.md", token, { fetchImpl: symlink })).rejects.toThrow("not a regular file");
  });

  it("lists directory entries and edit branches", async () => {
    const dir = vi.fn(async () => jsonResponse([{ name: "001-alpha" }, { name: "002-beta" }]));
    await expect(listDirectory(repo, "main", "initiatives/acme", token, { fetchImpl: dir })).resolves.toEqual([
      "001-alpha",
      "002-beta",
    ]);
    const refs = vi.fn(async () => jsonResponse([{ ref: `refs/heads/${branch}` }]));
    await expect(listBranches(repo, "snoboard/edits-", token, { fetchImpl: refs })).resolves.toEqual([branch]);
    expect(callsOf(refs)[0]?.url).toBe(
      `https://api.github.com/repos/${repo}/git/matching-refs/heads/snoboard/edits-?per_page=100`,
    );
  });

  it("reports whether the label was applied", async () => {
    const applied = vi.fn(async () => jsonResponse({ name: "snoboard" }));
    await expect(addLabelBestEffort(repo, 3, "snoboard", token, { fetchImpl: applied })).resolves.toBe(true);
    const missing = vi.fn(async () => jsonResponse({ message: "Not Found" }, 404));
    await expect(addLabelBestEffort(repo, 3, "snoboard", token, { fetchImpl: missing })).resolves.toBe(false);
  });
});
