import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IssueRef } from "./provider.js";
import { createVikunjaProvider, vikunjaBase } from "./vikunja.js";

const token = "vikunja-read-token";
const signal = new AbortController().signal;
const dirs: string[] = [];

function tokenFile(contents = `${token}\n`): string {
  const dir = mkdtempSync(join(tmpdir(), "snoboard-vikunja-"));
  dirs.push(dir);
  const file = join(dir, "token");
  writeFileSync(file, contents, "utf8");
  return file;
}

function ref(id = "456"): IssueRef {
  return { provider: "vikunja", key: id, raw: `vikunja:${id}` };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Vikunja provider", () => {
  it("links to the task without using the network", () => {
    const fetchImpl = vi.fn();
    const provider = createVikunjaProvider({
      baseUrl: "https://tasks.example/",
      tokenFile: tokenFile(),
      fetchImpl,
    });
    expect(provider.linkFor(ref())).toBe("https://tasks.example/tasks/456");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads an open task", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ id: 456, title: "Write the notes", done: false, updated: "2026-09-02T00:00:00Z" }),
    );
    const provider = createVikunjaProvider({
      baseUrl: "https://tasks.example",
      tokenFile: tokenFile(),
      fetchImpl,
    });
    const states = await provider.fetchStates([ref()], signal);
    expect(states.get("vikunja:456")).toEqual({
      raw: "vikunja:456",
      title: "Write the notes",
      state: "open",
      url: "https://tasks.example/tasks/456",
      updatedAt: "2026-09-02T00:00:00Z",
    });
    const call = fetchImpl.mock.calls[0];
    expect(String(call?.[0])).toBe("https://tasks.example/api/v1/tasks/456");
    const init = call?.[1] as RequestInit;
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${token}`);
  });

  it("treats done tasks as closed", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 7, title: "Shipped", done: true }));
    const provider = createVikunjaProvider({
      baseUrl: "https://tasks.example",
      tokenFile: tokenFile(),
      fetchImpl,
    });
    const states = await provider.fetchStates([ref("7")], signal);
    expect(states.get("vikunja:7")).toMatchObject({ title: "Shipped", state: "closed" });
  });

  it("returns unknown for a missing task", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "Not found" }, 404));
    const provider = createVikunjaProvider({
      baseUrl: "https://tasks.example",
      tokenFile: tokenFile(),
      fetchImpl,
    });
    const states = await provider.fetchStates([ref()], signal);
    expect(states.get("vikunja:456")).toEqual({
      raw: "vikunja:456",
      title: "",
      state: "unknown",
      url: "https://tasks.example/tasks/456",
    });
  });

  it("returns unknown when the token is rejected", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "Unauthorized" }, 401));
    const provider = createVikunjaProvider({
      baseUrl: "https://tasks.example",
      tokenFile: tokenFile(),
      fetchImpl,
    });
    const states = await provider.fetchStates([ref()], signal);
    expect(states.get("vikunja:456")?.state).toBe("unknown");
    expect(JSON.stringify(states.get("vikunja:456"))).not.toContain(token);
  });

  it("refuses a base URL that is not https outside localhost", async () => {
    const fetchImpl = vi.fn();
    const provider = createVikunjaProvider({
      baseUrl: "http://tasks.example",
      tokenFile: tokenFile(),
      fetchImpl,
    });
    expect(provider.linkFor(ref())).toBe("");
    const states = await provider.fetchStates([ref()], signal);
    expect(states.get("vikunja:456")?.state).toBe("unknown");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await provider.search?.("notes", signal)).toEqual([]);
  });

  it("allows http only for localhost", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 9, title: "Local", done: false }));
    const provider = createVikunjaProvider({
      baseUrl: "http://localhost:3456",
      tokenFile: tokenFile(),
      fetchImpl,
    });
    const states = await provider.fetchStates([ref("9")], signal);
    expect(states.get("vikunja:9")?.state).toBe("open");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://localhost:3456/api/v1/tasks/9");
    expect(provider.linkFor(ref("9"))).toBe("http://localhost:3456/tasks/9");
  });

  it("reads the token once at startup", async () => {
    const file = tokenFile("first-token\n");
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 456, title: "Notes", done: false }));
    const provider = createVikunjaProvider({
      baseUrl: "https://tasks.example",
      tokenFile: file,
      fetchImpl,
    });
    writeFileSync(file, "second-token\n", "utf8");
    await provider.fetchStates([ref()], signal);
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer first-token");
  });

  it("searches with a read-only GET and keeps ten results", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const tasks = Array.from({ length: 12 }, (_, index) => ({
        id: index + 1,
        title: `Task ${index + 1}`,
        done: index === 0,
      }));
      expect(String(input)).toBe("https://tasks.example/api/v1/tasks/all?s=notes&per_page=10");
      return jsonResponse(tasks);
    });
    const provider = createVikunjaProvider({
      baseUrl: "https://tasks.example",
      tokenFile: tokenFile(),
      fetchImpl,
    });
    const found = await provider.search?.("notes", signal);
    expect(found).toHaveLength(10);
    expect(found?.[0]).toMatchObject({ raw: "vj:1", state: "closed", title: "Task 1" });
    expect(found?.[1]).toMatchObject({ raw: "vj:2", state: "open" });
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("GET");
  });

  it("without a token file links to tasks and never calls Vikunja", async () => {
    const fetchImpl = vi.fn();
    const provider = createVikunjaProvider({ baseUrl: "https://tasks.example", fetchImpl });
    const vj = { provider: "vikunja", key: "45", raw: "vj:45" };
    expect(provider.parseRef(vj)).toBe(true);
    expect(provider.linkFor(vj)).toBe("https://tasks.example/tasks/45");
    const states = await provider.fetchStates([vj], signal);
    expect(states.get("vj:45")).toEqual({ raw: "vj:45", title: "", state: "unknown", url: "https://tasks.example/tasks/45" });
    expect(await provider.search?.("notes", signal)).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts only https site URLs (http for localhost)", () => {
    expect(vikunjaBase("https://tasks.example/")).toBe("https://tasks.example");
    expect(vikunjaBase("http://localhost:3456")).toBe("http://localhost:3456");
    expect(vikunjaBase("http://tasks.example")).toBeUndefined();
    expect(vikunjaBase("not a url")).toBeUndefined();
  });
});
