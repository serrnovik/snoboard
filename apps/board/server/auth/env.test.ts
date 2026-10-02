import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashPassword } from "./password.js";
import {
  bootAuth,
  getAuthConfig,
  getPublicAuthView,
  isArgon2idHash,
  loadAuthConfig,
  resetAuthConfig,
  setAuthConfig,
} from "./env.js";

const dirs: string[] = [];

afterEach(async () => {
  resetAuthConfig();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("auth environment", () => {
  it("fails fast when a configured mode is missing its secrets", async () => {
    const dir = await makeDir();
    const secret = Buffer.from("abcdefghijklmnopqrstuvwxyz012345");
    const secretFile = path.join(dir, "session");
    await writeFile(secretFile, secret);
    const hash = await hashPassword("correct-password");
    const hashFile = path.join(dir, "password");
    await writeFile(hashFile, hash);

    expect(() => loadAuthConfig({})).toThrow(/SNOBOARD_AUTH_MODES is required/);
    expect(() => bootAuth({})).toThrow(/SNOBOARD_AUTH_MODES is required/);
    expect(() =>
      loadAuthConfig({
        SNOBOARD_AUTH_MODES: "none",
        SNOBOARD_AUTH_ALLOW_NONE: "false",
      }),
    ).toThrow(/SNOBOARD_AUTH_ALLOW_NONE must be true/);
    expect(() =>
      loadAuthConfig({
        SNOBOARD_AUTH_MODES: "password,none",
        SNOBOARD_AUTH_ALLOW_NONE: "true",
      }),
    ).toThrow(/none cannot be combined/);

    let missingSecretMessage = "";
    try {
      loadAuthConfig({
        SNOBOARD_AUTH_MODES: "password",
        SNOBOARD_PUBLIC_URL: "http://localhost:3000",
        SNOBOARD_SESSION_SECRET_FILE: path.join(dir, "missing-secret"),
        SNOBOARD_PASSWORD_HASH_FILE: hashFile,
      });
    } catch (error) {
      missingSecretMessage = error instanceof Error ? error.message : "";
    }
    expect(missingSecretMessage).toMatch(/SNOBOARD_SESSION_SECRET_FILE is unreadable/);
    expect(missingSecretMessage).not.toContain(secret.toString("utf8"));

    await writeFile(path.join(dir, "short"), Buffer.alloc(31, 1));
    expect(() =>
      loadAuthConfig({
        SNOBOARD_AUTH_MODES: "password",
        SNOBOARD_PUBLIC_URL: "http://localhost:3000",
        SNOBOARD_SESSION_SECRET_FILE: path.join(dir, "short"),
        SNOBOARD_PASSWORD_HASH_FILE: hashFile,
      }),
    ).toThrow(/at least 32 bytes/);

    await writeFile(path.join(dir, "bad-hash"), "$2b$12$not-an-argon2-hash");
    expect(() =>
      loadAuthConfig({
        SNOBOARD_AUTH_MODES: "password",
        SNOBOARD_PUBLIC_URL: "https://board.example",
        SNOBOARD_SESSION_SECRET_FILE: secretFile,
        SNOBOARD_PASSWORD_HASH_FILE: path.join(dir, "bad-hash"),
      }),
    ).toThrow(/argon2id/);

    expect(() =>
      loadAuthConfig({
        SNOBOARD_AUTH_MODES: "github",
        SNOBOARD_PUBLIC_URL: "https://board.example",
        SNOBOARD_SESSION_SECRET_FILE: secretFile,
        SNOBOARD_GITHUB_CLIENT_ID: "client-id",
        SNOBOARD_GITHUB_CLIENT_SECRET_FILE: path.join(dir, "missing-client"),
      }),
    ).toThrow(/SNOBOARD_GITHUB_CLIENT_SECRET_FILE is unreadable/);

    const credentialUrl = ["https://user", "pass@board.example"].join(":");
    expect(() =>
      loadAuthConfig({
        SNOBOARD_AUTH_MODES: "password",
        SNOBOARD_PUBLIC_URL: credentialUrl,
        SNOBOARD_SESSION_SECRET_FILE: secretFile,
        SNOBOARD_PASSWORD_HASH_FILE: hashFile,
      }),
    ).toThrow(/must not include credentials/);
  });

  it("loads password, github, and explicit none mode", async () => {
    const dir = await makeDir();
    const secretFile = path.join(dir, "session");
    await writeFile(secretFile, Buffer.concat([randomBytes(32), Buffer.from("\n")]));
    const hash = await hashPassword("correct-password");
    expect(isArgon2idHash(hash)).toBe(true);
    const hashFile = path.join(dir, "password");
    await writeFile(hashFile, `${hash}\n`);
    const clientSecretFile = path.join(dir, "client");
    await writeFile(clientSecretFile, "synthetic-client-secret\n");

    const password = loadAuthConfig({
      SNOBOARD_AUTH_MODES: " password ",
      SNOBOARD_PUBLIC_URL: "http://localhost:4173/board",
      SNOBOARD_SESSION_SECRET_FILE: secretFile,
      SNOBOARD_PASSWORD_HASH_FILE: hashFile,
    });
    expect(password.modes).toEqual(["password"]);
    expect(password.publicUrl).toBe("http://localhost:4173");
    expect(password.sessionSecret?.length).toBeGreaterThanOrEqual(32);
    expect(password.passwordHash).toBe(hash);

    const github = loadAuthConfig({
      SNOBOARD_AUTH_MODES: "github",
      SNOBOARD_PUBLIC_URL: "https://board.example",
      SNOBOARD_SESSION_SECRET_FILE: secretFile,
      SNOBOARD_GITHUB_CLIENT_ID: "Iv1.client",
      SNOBOARD_GITHUB_CLIENT_SECRET_FILE: clientSecretFile,
      SNOBOARD_ALLOWED_GITHUB_LOGINS: "OctoCat, hubot",
      SNOBOARD_ALLOWED_GITHUB_ORGS: "Acme",
    });
    expect(github.github).toEqual({
      clientId: "Iv1.client",
      clientSecret: "synthetic-client-secret",
      allowedLogins: ["octocat", "hubot"],
      allowedOrgs: ["acme"],
      writeScope: "repo",
    });
    const publicOnly = loadAuthConfig({
      SNOBOARD_AUTH_MODES: "github",
      SNOBOARD_PUBLIC_URL: "https://board.example",
      SNOBOARD_SESSION_SECRET_FILE: secretFile,
      SNOBOARD_GITHUB_CLIENT_ID: "Iv1.client",
      SNOBOARD_GITHUB_CLIENT_SECRET_FILE: clientSecretFile,
      SNOBOARD_ALLOWED_GITHUB_LOGINS: "octocat",
      SNOBOARD_GITHUB_WRITE_SCOPE: "public_repo",
    });
    expect(publicOnly.github?.writeScope).toBe("public_repo");
    expect(() =>
      loadAuthConfig({
        SNOBOARD_AUTH_MODES: "github",
        SNOBOARD_PUBLIC_URL: "https://board.example",
        SNOBOARD_SESSION_SECRET_FILE: secretFile,
        SNOBOARD_GITHUB_CLIENT_ID: "Iv1.client",
        SNOBOARD_GITHUB_CLIENT_SECRET_FILE: clientSecretFile,
        SNOBOARD_ALLOWED_GITHUB_LOGINS: "octocat",
        SNOBOARD_GITHUB_WRITE_SCOPE: "admin:org",
      }),
    ).toThrow("SNOBOARD_GITHUB_WRITE_SCOPE");

    const open = loadAuthConfig({
      SNOBOARD_AUTH_MODES: "none",
      SNOBOARD_AUTH_ALLOW_NONE: "true",
    });
    expect(open.modes).toEqual(["none"]);
    expect(open.sessionSecret).toBeUndefined();

    bootAuth({ VITEST: "true", SNOBOARD_AUTH_MODES: "password" });
    expect(getAuthConfig().modes).toEqual([]);
    bootAuth({
      SNOBOARD_AUTH_MODES: "none",
      SNOBOARD_AUTH_ALLOW_NONE: "true",
    });
    expect(getPublicAuthView()).toEqual({ password: false, github: false, cloudflareAccess: false });
  });
});

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "snoboard-auth-"));
  dirs.push(dir);
  return dir;
}

describe("GitHub client id from a file", () => {
  it("reads SNOBOARD_GITHUB_CLIENT_ID_FILE", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { loadAuthConfig } = await import("./env.js");
    const dir = mkdtempSync(path.join(os.tmpdir(), "snoboard-cid-"));
    const write = (name: string, text: string) => {
      const file = path.join(dir, name);
      writeFileSync(file, text);
      return file;
    };
    const config = loadAuthConfig({
      SNOBOARD_AUTH_MODES: "github",
      SNOBOARD_PUBLIC_URL: "https://board.example",
      SNOBOARD_SESSION_SECRET_FILE: write("session", "s".repeat(48)),
      SNOBOARD_GITHUB_CLIENT_ID_FILE: write("client-id", "Ov23liExampleClientId\n"),
      SNOBOARD_GITHUB_CLIENT_SECRET_FILE: write("client-secret", "0123456789abcdef"),
      SNOBOARD_ALLOWED_GITHUB_LOGINS: "octocat",
    });
    expect(config.github?.clientId).toBe("Ov23liExampleClientId");
  });
});

describe("cloudflare access environment", () => {
  it("fails at boot when the mode is combined or its settings are missing", () => {
    expect(() =>
      loadAuthConfig({
        SNOBOARD_AUTH_MODES: "cloudflare-access,password",
      }),
    ).toThrow(/cloudflare-access cannot be combined/);
    expect(() =>
      loadAuthConfig({
        SNOBOARD_AUTH_MODES: "cloudflare-access,none",
        SNOBOARD_AUTH_ALLOW_NONE: "true",
      }),
    ).toThrow(/cannot be combined/);
    expect(() => loadAuthConfig({ SNOBOARD_AUTH_MODES: "cloudflare-access" })).toThrow(
      /SNOBOARD_CF_ACCESS_TEAM_DOMAIN is required/,
    );
    expect(() =>
      loadAuthConfig({
        SNOBOARD_AUTH_MODES: "cloudflare-access",
        SNOBOARD_CF_ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com",
        SNOBOARD_CF_ACCESS_AUD: "audience-tag",
        SNOBOARD_ALLOWED_EMAILS: "ada@example.com",
      }),
    ).toThrow(/must be a hostname/);
    expect(() =>
      loadAuthConfig({
        SNOBOARD_AUTH_MODES: "cloudflare-access",
        SNOBOARD_CF_ACCESS_TEAM_DOMAIN: "example.com",
        SNOBOARD_CF_ACCESS_AUD: "audience-tag",
        SNOBOARD_ALLOWED_EMAILS: "ada@example.com",
      }),
    ).toThrow(/must end in \.cloudflareaccess\.com/);
    expect(() =>
      loadAuthConfig({
        SNOBOARD_AUTH_MODES: "cloudflare-access",
        SNOBOARD_CF_ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
        SNOBOARD_ALLOWED_EMAILS: "ada@example.com",
      }),
    ).toThrow(/SNOBOARD_CF_ACCESS_AUD is required/);
    expect(() =>
      loadAuthConfig({
        SNOBOARD_AUTH_MODES: "cloudflare-access",
        SNOBOARD_CF_ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
        SNOBOARD_CF_ACCESS_AUD: "audience-tag",
      }),
    ).toThrow(/SNOBOARD_ALLOWED_EMAILS or SNOBOARD_ALLOWED_EMAIL_DOMAINS/);
    expect(() =>
      loadAuthConfig({
        SNOBOARD_AUTH_MODES: "cloudflare-access",
        SNOBOARD_CF_ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
        SNOBOARD_CF_ACCESS_AUD: "audience-tag",
        SNOBOARD_ALLOWED_EMAILS: "not-an-email",
      }),
    ).toThrow(/SNOBOARD_ALLOWED_EMAILS contains an invalid value/);
  });

  it("loads the team domain, audiences, and requires an email or domain allowlist", () => {
    const config = loadAuthConfig({
      SNOBOARD_AUTH_MODES: " cloudflare-access ",
      SNOBOARD_CF_ACCESS_TEAM_DOMAIN: "Example.CloudflareAccess.com",
      SNOBOARD_CF_ACCESS_AUD: "aud-1, aud-2",
      SNOBOARD_ALLOWED_EMAILS: "Ada@Example.com",
      SNOBOARD_ALLOWED_EMAIL_DOMAINS: "Example.com",
      SNOBOARD_CF_ACCESS_ALLOWED_GROUPS: "Board Readers",
    });
    expect(config.modes).toEqual(["cloudflare-access"]);
    expect(config.sessionSecret).toBeUndefined();
    expect(config.passwordHash).toBeUndefined();
    expect(config.github).toBeUndefined();
    expect(config.cloudflareAccess).toEqual({
      teamDomain: "example.cloudflareaccess.com",
      audiences: ["aud-1", "aud-2"],
      allowedEmails: ["ada@example.com"],
      allowedEmailDomains: ["example.com"],
      allowedGroups: ["board readers"],
    });

    const domainOnly = loadAuthConfig({
      SNOBOARD_AUTH_MODES: "cloudflare-access",
      SNOBOARD_CF_ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
      SNOBOARD_CF_ACCESS_AUD: "audience-tag",
      SNOBOARD_ALLOWED_EMAIL_DOMAINS: "example.com",
    });
    expect(domainOnly.cloudflareAccess?.allowedEmailDomains).toEqual(["example.com"]);

    expect(() =>
      loadAuthConfig({
        SNOBOARD_AUTH_MODES: "cloudflare-access",
        SNOBOARD_CF_ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
        SNOBOARD_CF_ACCESS_AUD: "audience-tag",
        SNOBOARD_CF_ACCESS_ALLOWED_GROUPS: "readers",
      }),
    ).toThrow(/SNOBOARD_ALLOWED_EMAILS or SNOBOARD_ALLOWED_EMAIL_DOMAINS/);

    setAuthConfig(config);
    expect(getPublicAuthView()).toEqual({ password: false, github: false, cloudflareAccess: true });
  });
  it("loads the GitHub OAuth client for write-connect only when SNOBOARD_GITHUB_WRITE_CONNECT is on", async () => {
    const dir = await makeDir();
    const clientSecretFile = path.join(dir, "client-secret");
    await writeFile(clientSecretFile, "synthetic-client-secret\n");
    const base = {
      SNOBOARD_AUTH_MODES: "cloudflare-access",
      SNOBOARD_CF_ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
      SNOBOARD_CF_ACCESS_AUD: "audience-tag",
      SNOBOARD_ALLOWED_EMAIL_DOMAINS: "example.com",
      SNOBOARD_GITHUB_CLIENT_ID: "client-id",
      SNOBOARD_GITHUB_CLIENT_SECRET_FILE: clientSecretFile,
      SNOBOARD_PUBLIC_URL: "https://board.example/",
    };
    // The client alone does nothing: the switch is explicit.
    expect(loadAuthConfig(base).github).toBeUndefined();
    expect(loadAuthConfig(base).githubWriteConnect).toBeUndefined();

    const on = loadAuthConfig({ ...base, SNOBOARD_GITHUB_WRITE_CONNECT: "true", SNOBOARD_GITHUB_WRITE_SCOPE: "public_repo" });
    expect(on.githubWriteConnect).toBe(true);
    expect(on.publicUrl).toBe("https://board.example");
    expect(on.sessionSecret?.length).toBe(32);
    expect(on.github).toMatchObject({ clientId: "client-id", allowedLogins: [], allowedOrgs: [], writeScope: "public_repo" });
    setAuthConfig(on);
    expect(getPublicAuthView()).toEqual({ password: false, github: false, cloudflareAccess: true });

    const narrowed = loadAuthConfig({ ...base, SNOBOARD_GITHUB_WRITE_CONNECT: "1", SNOBOARD_ALLOWED_GITHUB_LOGINS: "OctoCat" });
    expect(narrowed.github?.allowedLogins).toEqual(["octocat"]);

    expect(() => loadAuthConfig({ ...base, SNOBOARD_GITHUB_WRITE_CONNECT: "true", SNOBOARD_PUBLIC_URL: "" })).toThrow(
      /SNOBOARD_PUBLIC_URL is required/,
    );
    expect(() =>
      loadAuthConfig({ ...base, SNOBOARD_GITHUB_WRITE_CONNECT: "true", SNOBOARD_GITHUB_CLIENT_SECRET_FILE: "" }),
    ).toThrow(/SNOBOARD_GITHUB_CLIENT_SECRET_FILE is required/);
    expect(() =>
      loadAuthConfig({ ...base, SNOBOARD_GITHUB_WRITE_CONNECT: "true", SNOBOARD_ALLOWED_GITHUB_ORGS: "acme" }),
    ).toThrow(/SNOBOARD_ALLOWED_GITHUB_ORGS is not supported/);
    expect(() => loadAuthConfig({ ...base, SNOBOARD_GITHUB_WRITE_CONNECT: "yes" })).toThrow(/true or false/);
  });
});
