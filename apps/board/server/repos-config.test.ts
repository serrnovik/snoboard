import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetEditConfig, setEditConfig } from "./edit-env.js";
import { getProposals, resetProposals, setProposals } from "./proposals.js";
import {
  botTokenFileFor,
  editSettingsFor,
  loadReposConfig,
  resetActiveRepos,
  setActiveRepos,
} from "./repos-config.js";

const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "snoboard-repos-"));
  dirs.push(dir);
  return dir;
}

function yamlQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function writeRepos(dir: string, yaml: string): Promise<string> {
  const file = path.join(dir, "repos.yml");
  await writeFile(file, yaml, "utf8");
  return file;
}

describe("loadReposConfig", () => {
  it("loads several repositories from SNOBOARD_REPOS_FILE, including a public https URL", async () => {
    const dir = await tempDir();
    const key = path.join(dir, "acme-key");
    await writeFile(key, "example-key-material\n", "utf8");
    const file = await writeRepos(
      dir,
      `repos:
  - id: acme
    name: Acme platform
    url: git@github.com:example/acme.git
    sshKeyFile: ${yamlQuote(key)}
    edit:
      modes: [pr]
      baseBranch: main
    issues:
      github: { repo: example/acme }
      vikunja: { baseUrl: https://tasks.example.com, tokenFile: /secrets/vikunja-token }
  - id: demo
    name: Public demo
    url: https://github.com/example/demo.git
    edit:
      modes: [direct]
      directBranch: main
`,
    );
    const repos = loadReposConfig({ SNOBOARD_REPOS_FILE: file });
    expect(repos).toEqual([
      {
        id: "acme",
        name: "Acme platform",
        url: "git@github.com:example/acme.git",
        sshKeyFile: key,
        edit: { modes: ["pr"], baseBranch: "main" },
        issues: {
          github: { repo: "example/acme" },
          vikunja: { baseUrl: "https://tasks.example.com", tokenFile: "/secrets/vikunja-token" },
        },
      },
      {
        id: "demo",
        name: "Public demo",
        url: "https://github.com/example/demo.git",
        edit: { modes: ["direct"], directBranch: "main" },
      },
    ]);
    expect(JSON.stringify(repos)).not.toContain("example-key-material");
  });

  it("builds one default repo from the single-repo environment", async () => {
    const dir = await tempDir();
    const key = path.join(dir, "key");
    const token = path.join(dir, "token");
    const config = path.join(dir, "board.yml");
    const bot = path.join(dir, "bot");
    await writeFile(key, "example-key-material\n", "utf8");
    await writeFile(token, "example-token-material\n", "utf8");
    await writeFile(config, "root: initiatives\n", "utf8");
    await writeFile(bot, "example-bot-material\n", "utf8");
    expect(
      loadReposConfig({
        SNOBOARD_REPO_URL: "https://example.com/acme/board.git",
        SNOBOARD_SSH_KEY_FILE: key,
        SNOBOARD_GIT_TOKEN_FILE: token,
        SNOBOARD_CONFIG_PATH: config,
        SNOBOARD_EDIT_MODES: "pr, direct",
        SNOBOARD_EDIT_BASE_BRANCH: "main",
        SNOBOARD_EDIT_DIRECT_BRANCH: "live",
        SNOBOARD_EDIT_BOT_TOKEN_FILE: bot,
      }),
    ).toEqual([
      {
        id: "default",
        name: "default",
        url: "https://example.com/acme/board.git",
        sshKeyFile: key,
        gitTokenFile: token,
        configPath: config,
        edit: {
          modes: ["pr", "direct"],
          baseBranch: "main",
          directBranch: "live",
          botTokenFile: bot,
        },
      },
    ]);
    expect(loadReposConfig({ SNOBOARD_REPO_URL: " https://example.com/acme/public.git " })).toEqual([
      {
        id: "default",
        name: "default",
        url: "https://example.com/acme/public.git",
        edit: { modes: [] },
      },
    ]);
    expect(() => loadReposConfig({})).toThrow(/SNOBOARD_REPO_URL/);
  });

  it("rejects a duplicate repository id", async () => {
    const dir = await tempDir();
    const file = await writeRepos(
      dir,
      `repos:
  - id: acme
    name: One
    url: https://example.com/one.git
  - id: acme
    name: Two
    url: https://example.com/two.git
`,
    );
    expect(() => loadReposConfig({ SNOBOARD_REPOS_FILE: file })).toThrow(/duplicate repository id: acme/);
  });

  it("accepts a Vikunja block without tokenFile and requires an https baseUrl", async () => {
    const dir = await tempDir();
    const ok = await writeRepos(
      dir,
      `repos:
  - id: acme
    name: Acme
    url: https://example.com/acme.git
    issues:
      vikunja: { baseUrl: https://tasks.example.com }
`,
    );
    expect(loadReposConfig({ SNOBOARD_REPOS_FILE: ok })[0]?.issues).toEqual({
      vikunja: { baseUrl: "https://tasks.example.com" },
    });
    const bad = await writeRepos(
      dir,
      `repos:
  - id: acme
    name: Acme
    url: https://example.com/acme.git
    issues:
      vikunja: { baseUrl: http://tasks.example.com }
`,
    );
    expect(() => loadReposConfig({ SNOBOARD_REPOS_FILE: bad })).toThrow(/vikunja baseUrl must be an https URL/);
  });

  it("rejects a repository id outside [a-z0-9-]{1,32}", async () => {
    const dir = await tempDir();
    const file = await writeRepos(
      dir,
      `repos:
  - id: Bad_Id
    name: Bad
    url: https://example.com/bad.git
`,
    );
    expect(() => loadReposConfig({ SNOBOARD_REPOS_FILE: file })).toThrow(/Bad_Id|must match/);
  });

  it("rejects a missing key file and an ssh URL without one", async () => {
    const dir = await tempDir();
    const missing = path.join(dir, "missing-key");
    const ssh = await writeRepos(
      dir,
      `repos:
  - id: acme
    name: Acme
    url: git@github.com:example/acme.git
    sshKeyFile: ${yamlQuote(missing)}
`,
    );
    expect(() => loadReposConfig({ SNOBOARD_REPOS_FILE: ssh })).toThrow(/missing key file/);
    const tokenFile = path.join(dir, "missing-token");
    expect(() =>
      loadReposConfig({
        SNOBOARD_REPO_URL: "https://example.com/acme/board.git",
        SNOBOARD_GIT_TOKEN_FILE: tokenFile,
      }),
    ).toThrow(/missing key file/);
    expect(() =>
      loadReposConfig({ SNOBOARD_REPO_URL: "ssh://git@github.com/example/acme.git" }),
    ).toThrow(/sshKeyFile/);
    const scheme = ["https", "://"].join("");
    const secretUrl = `${scheme}user:${["s3cret", "pass"].join("")}@example.com/acme/board.git`;
    expect(() => loadReposConfig({ SNOBOARD_REPO_URL: secretUrl })).toThrow(/credentials/);
  });

  it("uses the repos file when single-repo env is also set and logs a warning", async () => {
    const dir = await tempDir();
    const file = await writeRepos(
      dir,
      `repos:
  - id: demo
    name: Public demo
    url: https://github.com/example/demo.git
`,
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const repos = loadReposConfig({
      SNOBOARD_REPOS_FILE: file,
      SNOBOARD_REPO_URL: "https://example.com/ignored.git",
      SNOBOARD_EDIT_MODES: "pr",
    });
    expect(repos.map((repo) => repo.url)).toEqual(["https://github.com/example/demo.git"]);
    expect(repos[0]?.id).toBe("demo");
    const logged = warn.mock.calls.flat().join("\n");
    expect(logged).toContain("SNOBOARD_REPOS_FILE");
    expect(logged).toContain("SNOBOARD_REPO_URL");
    expect(logged).not.toContain("https://example.com/ignored.git");
  });
});

describe("per-repo edit scoping", () => {
  afterEach(() => {
    resetActiveRepos();
    resetEditConfig();
    resetProposals();
  });

  it("reads modes and the bot token only from the target repo, never another repo or the env", async () => {
    const dir = await tempDir();
    const bot = path.join(dir, "alpha-bot");
    await writeFile(bot, "alpha-token\n", "utf8");
    setEditConfig({ enabled: true, modes: ["direct"], directBranch: "main", botTokenConfigured: true });
    setActiveRepos([
      { id: "alpha", name: "Alpha", url: "https://example.com/alpha.git", edit: { modes: ["pr"], botTokenFile: bot } },
      { id: "beta", name: "Beta", url: "https://example.com/beta.git", edit: { modes: ["direct"], directBranch: "live" } },
    ]);
    const env = { SNOBOARD_EDIT_BOT_TOKEN_FILE: bot };

    expect(editSettingsFor("alpha")).toMatchObject({ enabled: true, modes: ["pr"], botTokenConfigured: true });
    expect(editSettingsFor("beta")).toMatchObject({
      enabled: true,
      modes: ["direct"],
      directBranch: "live",
      botTokenConfigured: false,
    });
    expect(botTokenFileFor("alpha", env)).toBe(bot);
    expect(botTokenFileFor("beta", env)).toBeUndefined();
    // With a catalog, "default" and unknown ids are not editable, even if the env enables editing.
    expect(editSettingsFor("default").enabled).toBe(false);
    expect(editSettingsFor("gamma").enabled).toBe(false);
    expect(botTokenFileFor("default", env)).toBeUndefined();
  });

  it("keeps the single-repo env settings for the default repo when no catalog is published", () => {
    setEditConfig({ enabled: true, modes: ["pr"], botTokenConfigured: false });
    expect(editSettingsFor("default")).toMatchObject({ enabled: true, modes: ["pr"] });
    expect(editSettingsFor("alpha").enabled).toBe(false);
    expect(botTokenFileFor("default", { SNOBOARD_EDIT_BOT_TOKEN_FILE: " /run/bot " })).toBe("/run/bot");
    expect(botTokenFileFor("alpha", { SNOBOARD_EDIT_BOT_TOKEN_FILE: "/run/bot" })).toBeUndefined();
  });

  it("accepts a per-repo GitHub write scope in the repos file", async () => {
    const dir = await tempDir();
    const file = await writeRepos(
      dir,
      [
        "repos:",
        "  - id: site",
        "    name: Site",
        "    url: https://example.com/site.git",
        "    edit:",
        "      modes: [pr]",
        "      githubWriteScope: public_repo",
        "",
      ].join("\n"),
    );
    const [repo] = loadReposConfig({ SNOBOARD_REPOS_FILE: file });
    expect(repo?.edit).toEqual({ modes: ["pr"], githubWriteScope: "public_repo" });
    const bad = await writeRepos(
      dir,
      ["repos:", "  - id: x", "    name: X", "    url: https://example.com/x.git", "    edit:", "      githubWriteScope: admin", ""].join(
        String.fromCharCode(10),
      ),
    );
    expect(() => loadReposConfig({ SNOBOARD_REPOS_FILE: bad })).toThrow(/githubWriteScope/);
  });

  it("keeps proposals per repository", () => {
    setProposals([{ branch: "snoboard/edits-1", initiativeId: "a-001", fields: [] }], "alpha");
    expect(getProposals("alpha")).toHaveLength(1);
    expect(getProposals("beta")).toEqual([]);
    expect(getProposals()).toEqual([]);
  });
});
