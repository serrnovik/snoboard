import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { main, type CliIo } from "./cli.js";
import { addRemote, createBareClone } from "./test-utils/tmp-repo.js";

const demoRoot = fileURLToPath(new URL("../../../examples/demo-repo", import.meta.url));
const parents: string[] = [];

afterEach(async () => {
  const pending = parents.splice(0);
  await Promise.all(pending.map((dir) => removeDir(dir)));
});

describe("snoboard cli", () => {
  it("declares the package bin and a node shebang", () => {
    const source = readFileSync(fileURLToPath(new URL("./cli.ts", import.meta.url)), "utf8");
    expect(source).toMatch(/^#!\/usr\/bin\/env node\r?\n/);
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { bin?: { snoboard?: string } };
    expect(pkg.bin?.snoboard).toBe("dist/cli.js");
  });

  it("prints the version and help", async () => {
    const version = await run(["--version"]);
    expect(version.code).toBe(0);
    expect(version.stdout).toBe("0.1.0\n");
    expect(version.stderr).toBe("");

    const help = await run(["--help"]);
    expect(help.code).toBe(0);
    for (const flag of [
      "--repo",
      "--ref",
      "--changed-since",
      "--json",
      "--fetch",
      "--ready",
      "--stale",
      "--project",
      "--title",
      "--priority",
      "--dry-run",
      "--version",
      "--help",
    ]) {
      expect(help.stdout).toContain(flag);
    }
  });

  it("rejects unknown commands and flags", async () => {
    expect((await run(["nope"])).code).toBe(2);
    expect((await run([])).code).toBe(2);
    expect((await run(["validate", "--ready"])).code).toBe(2);
    expect((await run(["validate", "--dry-run"])).code).toBe(2);
    expect((await run(["--not-a-flag"])).code).toBe(2);
  });

  it("validate names the broken demo folder and passes once it is gone", async () => {
    const dir = await initDemo();
    const failed = await run(["validate", "--repo", dir]);
    expect(failed.code).toBe(1);
    expect(failed.stdout).toContain("platform/002-broken");

    await rm(path.join(dir, "initiatives", "platform", "002-broken"), {
      recursive: true,
      force: true,
    });
    const passed = await run(["validate", "--repo", dir]);
    expect(passed.code).toBe(0);
    expect(passed.stdout).not.toContain("platform/002-broken");
  });

  it("validate --ref reads the commit, not the working tree", async () => {
    const dir = await initDemo();
    await rm(path.join(dir, "initiatives", "platform", "002-broken"), {
      recursive: true,
      force: true,
    });
    const working = await run(["validate", "--repo", dir]);
    expect(working.code).toBe(0);
    const committed = await run(["validate", "--ref", "HEAD", "--repo", dir]);
    expect(committed.code).toBe(1);
    expect(committed.stdout).toContain("platform/002-broken");
  });

  it("validate --json exits 1 and includes the broken path", async () => {
    const dir = await initDemo();
    const result = await run(["validate", "--json", "--repo", dir]);
    expect(result.code).toBe(1);
    const issues = JSON.parse(result.stdout) as Array<{ path: string; severity: string }>;
    expect(issues.some((issue) => issue.path.includes("platform/002-broken") && issue.severity === "error")).toBe(
      true,
    );
  });

  it("warnings are printed and do not fail validate", async () => {
    const dir = await initDemo();
    await rm(path.join(dir, "initiatives", "platform", "002-broken"), {
      recursive: true,
      force: true,
    });
    const file = path.join(dir, "initiatives", "acme", "003-reports", "initiative.md");
    const text = await readFile(file, "utf8");
    await writeFile(file, text.replace("updated: 2026-09-29", "updated: 2020-01-01"));
    const result = await run(["validate", "--repo", dir]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("warning:");
    expect(result.stdout).toContain("initiatives/acme/003-reports/initiative.md");
  });

  it("validate --changed-since uses the triple-dot diff under the config root", async () => {
    const dir = await initDemo();
    await replaceIn(
      dir,
      ["initiatives", "acme", "003-reports", "initiative.md"],
      "title: Reports",
      "title: Reports updated",
    );
    await commitAll(dir, "touch reports");
    const calls: string[][] = [];
    const result = await run(["validate", "--changed-since", "HEAD~1", "--repo", dir], {
      onGit: (args) => calls.push([...args]),
    });
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("platform/002-broken");
    expect(
      calls.some(
        (args) =>
          args.includes("diff") &&
          args.includes("--name-only") &&
          args.includes("HEAD~1...HEAD") &&
          args.at(-2) === "--" &&
          args.at(-1) === "initiatives",
      ),
    ).toBe(true);
    const full = await run(["validate", "--repo", dir]);
    expect(full.code).toBe(1);
  });

  it("validate --changed-since still reports a new duplicate id", async () => {
    const dir = await initDemo();
    await writeInitiative(dir, "acme", "001-clone", "acme-001", "Clone");
    await commitAll(dir, "duplicate id");
    const result = await run(["validate", "--changed-since", "HEAD~1", "--repo", dir]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('duplicate id "acme-001"');
  });

  it("validate --changed-since ignores a duplicate that the commit did not touch", async () => {
    const dir = await initDemo();
    await writeInitiative(dir, "acme", "001-clone", "acme-001", "Clone");
    await commitAll(dir, "duplicate id");
    await replaceIn(
      dir,
      ["initiatives", "acme", "003-reports", "initiative.md"],
      "title: Reports",
      "title: Reports updated",
    );
    await commitAll(dir, "touch reports");
    const incremental = await run(["validate", "--changed-since", "HEAD~1", "--repo", dir]);
    expect(incremental.code).toBe(0);
    const full = await run(["validate", "--repo", dir]);
    expect(full.code).toBe(1);
    expect(full.stdout).toContain('duplicate id "acme-001"');
  });

  it("next-number acme is 004, and a matching branch with 004-x makes it 005", async () => {
    const dir = await initDemo();
    expect((await run(["next-number", "acme", "--repo", dir])).stdout).toBe("004\n");
    expect((await run(["next-number", "platform", "--repo", dir])).stdout).toBe("003\n");

    await git(dir, ["switch", "-c", "topic/acme-004"]);
    await writeInitiative(dir, "acme", "004-x", "acme-004", "Extra");
    await commitAll(dir, "topic 004");
    await git(dir, ["switch", "main"]);
    expect((await run(["next-number", "acme", "--repo", dir])).stdout).toBe("004\n");

    await git(dir, ["switch", "-c", "initiative/acme-004-x"]);
    await writeInitiative(dir, "acme", "004-x", "acme-004", "Extra");
    await commitAll(dir, "matching 004");
    await git(dir, ["switch", "main"]);
    expect((await run(["next-number", "acme", "--repo", dir])).stdout).toBe("005\n");
  });

  it("next-number skips reservedNumbers parking-lot folders", async () => {
    const dir = await initDemo();
    await writeInitiative(dir, "acme", "999-parking", "acme-999", "Parking lot");
    await commitAll(dir, "parking lot");
    const overflow = await run(["next-number", "acme", "--repo", dir]);
    expect(overflow.code).not.toBe(0);
    expect(overflow.stdout).toBe("");
    expect(overflow.stderr).toContain("reservedNumbers");

    await writeFile(path.join(dir, ".snoboard.yml"), "reservedNumbers: [4, 999]\n", "utf8");
    await commitAll(dir, "reserve 4 and 999");
    expect((await run(["next-number", "acme", "--repo", dir])).stdout).toBe("005\n");
  });

  it("next-number --fetch sees a matching branch that exists only on origin", async () => {
    const dir = await initDemo();
    await git(dir, ["switch", "-c", "initiative/acme-004"]);
    await writeInitiative(dir, "acme", "004-x", "acme-004", "Extra");
    await commitAll(dir, "remote 004");
    await git(dir, ["switch", "main"]);
    const bare = await createBareClone(dir);
    parents.push(path.dirname(bare.dir));
    await git(dir, ["branch", "-D", "initiative/acme-004"]);
    await addRemote(dir, bare.dir);

    expect((await run(["next-number", "acme", "--repo", dir])).stdout).toBe("004\n");
    const calls: string[][] = [];
    const fetched = await run(["next-number", "acme", "--fetch", "--repo", dir], {
      onGit: (args) => calls.push([...args]),
    });
    expect(fetched.code).toBe(0);
    expect(fetched.stdout).toBe("005\n");
    expect(calls.some((args) => args[0] === "fetch" && args.includes("origin"))).toBe(true);
    await bare.remove();
  });

  it("status is a table, and --ready --json is acme-003 only after acme-002 is done", async () => {
    const dir = await initDemo();
    const table = await run(["status", "--repo", dir]);
    expect(table.code).toBe(0);
    expect(table.stdout).toBe(
      [
        "id        title                status       priority  updated     ready",
        "acme-001  Customer onboarding  done         p1        2026-09-29  no",
        "acme-002  Billing              in-progress  p1        2026-09-29  yes",
        "acme-003  Reports              planned      p2        2026-09-29  no",
        "",
      ].join("\n"),
    );

    const before = await run(["status", "--ready", "--json", "--repo", dir]);
    expect(before.code).toBe(0);
    expect(ids(before.stdout)).toEqual(["acme-002"]);

    await replaceIn(
      dir,
      ["initiatives", "acme", "002-billing", "initiative.md"],
      "status: in-progress",
      "status: done",
    );
    await commitAll(dir, "mark acme-002 done");
    const after = await run(["status", "--ready", "--json", "--repo", dir]);
    expect(after.code).toBe(0);
    expect(ids(after.stdout)).toEqual(["acme-003"]);
  });

  it("status --project and --stale filter the JSON list", async () => {
    const dir = await initDemo();
    await replaceIn(
      dir,
      ["initiatives", "acme", "003-reports", "initiative.md"],
      "updated: 2026-09-29",
      "updated: 2020-01-01",
    );
    await commitAll(dir, "stale reports");
    const project = await run(["status", "--project", "acme", "--json", "--repo", dir]);
    expect(ids(project.stdout)).toEqual(["acme-001", "acme-002", "acme-003"]);
    const stale = await run(["status", "--stale", "--json", "--repo", dir]);
    expect(stale.code).toBe(0);
    const rows = JSON.parse(stale.stdout) as Array<{ id: string; stale: boolean }>;
    expect(rows.map((row) => row.id)).toEqual(["acme-003"]);
    expect(rows[0]?.stale).toBe(true);
    expect((await run(["status", "--ready", "--stale", "--repo", dir])).code).toBe(2);
  });

  it("new acme search creates a folder that validate accepts", async () => {
    const dir = await initDemo();
    await rm(path.join(dir, "initiatives", "platform", "002-broken"), {
      recursive: true,
      force: true,
    });
    const created = await run(["new", "acme", "search", "--title", "Search", "--repo", dir]);
    expect(created.code).toBe(0);
    expect(created.stdout).toBe("initiatives/acme/004-search/initiative.md\n");
    const file = path.join(dir, "initiatives", "acme", "004-search", "initiative.md");
    const text = await readFile(file, "utf8");
    expect(text).toContain("id: acme-004");
    expect(text).toContain('title: "Search"');
    expect(text).toContain("status: idea");
    expect(text).toContain("priority: p2");
    expect(text).toContain("## Summary");
    expect(text).toContain("## Goals");
    expect(text).toContain("## Phases");
    const checked = await run(["validate", "--repo", dir]);
    expect(checked.code).toBe(0);

    await mkdir(path.join(dir, "initiatives", "acme", "005-search"));
    const refused = await run(["new", "acme", "search", "--title", "Search", "--repo", dir]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("Folder already exists: initiatives/acme/005-search");
  });
});

function ids(stdout: string): string[] {
  return (JSON.parse(stdout) as Array<{ id: string }>).map((row) => row.id);
}

async function run(
  args: readonly string[],
  io?: Pick<CliIo, "onGit">,
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await main(args, {
    cwd: args.includes("--repo") ? String(args[args.indexOf("--repo") + 1]) : process.cwd(),
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    onGit: io?.onGit,
  });
  return { code, stdout, stderr };
}

async function initDemo(): Promise<string> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "snoboard-cli-"));
  parents.push(parent);
  const dir = path.join(parent, "repo");
  await cp(demoRoot, dir, { recursive: true });
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.email", "snoboard@example.com"]);
  await git(dir, ["config", "user.name", "Snoboard Tests"]);
  await git(dir, ["config", "commit.gpgsign", "false"]);
  await git(dir, ["config", "core.autocrlf", "false"]);
  await git(dir, ["config", "core.safecrlf", "false"]);
  const hooks = path.join(dir, ".git", "snoboard-hooks");
  await mkdir(hooks, { recursive: true });
  await git(dir, ["config", "core.hooksPath", hooks]);
  await commitAll(dir, "demo");
  return dir;
}

async function commitAll(repoDir: string, message: string): Promise<void> {
  await git(repoDir, ["add", "-A"]);
  await git(repoDir, ["commit", "-m", message]);
}

async function replaceIn(
  repoDir: string,
  parts: readonly string[],
  from: string,
  to: string,
): Promise<void> {
  const file = path.join(repoDir, ...parts);
  const text = await readFile(file, "utf8");
  if (!text.includes(from)) throw new Error(`missing ${from} in ${file}`);
  await writeFile(file, text.replace(from, to));
}

async function writeInitiative(
  repoDir: string,
  project: string,
  folder: string,
  id: string,
  title: string,
): Promise<void> {
  const dir = path.join(repoDir, "initiatives", project, folder);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "initiative.md"),
    [
      "---",
      `id: ${id}`,
      `title: ${title}`,
      "status: planned",
      "priority: p3",
      "updated: 2026-09-29",
      "---",
      "",
      `# ${title}`,
      "",
      "## Summary",
      "",
      title,
      "",
    ].join("\n"),
  );
}

function git(repoDir: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["--no-pager", ...args], {
      cwd: repoDir,
      windowsHide: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (stdout === null || stderr === null) {
      child.kill();
      reject(new Error("git stdio was not piped"));
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    stdout.on("data", (chunk: Buffer | string) => {
      out.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    stderr.on("data", (chunk: Buffer | string) => {
      err.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if ((code ?? 1) !== 0) {
        reject(
          new Error(
            `git ${args.join(" ")} failed (${code ?? 1}): ${Buffer.concat(err).toString("utf8")}`,
          ),
        );
        return;
      }
      resolve(Buffer.concat(out).toString("utf8"));
    });
  });
}

async function removeDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}
