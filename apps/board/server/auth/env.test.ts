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
    });

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
    expect(getPublicAuthView()).toEqual({ password: false, github: false });
  });
});

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "snoboard-auth-"));
  dirs.push(dir);
  return dir;
}
