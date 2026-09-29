import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hash } from "@node-rs/argon2";
import { E2E_FIXTURE, E2E_ORIGIN, E2E_PASSWORD, E2E_PORT } from "./constants.ts";

const boardRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = path.resolve(boardRoot, "../..");

function run(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: workspaceRoot,
      windowsHide: true,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if ((code ?? 1) !== 0) {
        reject(new Error(`${command} ${args.join(" ")} failed (${code ?? 1})`));
        return;
      }
      resolve();
    });
  });
}

const fixturePath = path.join(os.tmpdir(), E2E_FIXTURE);

export default async function globalSetup(): Promise<void> {
  // Playwright starts webServer before this hook. The server command runs this
  // file first; the hook then sees a fixture that is only a few seconds old.
  if (!isDirectRun()) {
    try {
      const info = await stat(fixturePath);
      if (Date.now() - info.mtimeMs < 60_000) return;
    } catch {
      // Create a new fixture below.
    }
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "snoboard-e2e-"));
  const remote = path.join(root, "demo.git");
  const dataDir = path.join(root, "data");
  const hashFile = path.join(root, "password-hash");
  const secretFile = path.join(root, "session-secret");
  await mkdir(dataDir, { recursive: true });
  await run(process.execPath, [path.join(workspaceRoot, "examples/make-demo-remote.mjs"), remote]);
  const passwordHash = await hash(E2E_PASSWORD, {
    algorithm: 2,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
  await writeFile(hashFile, `${passwordHash}\n`, "utf8");
  await writeFile(secretFile, randomBytes(48).toString("base64"), "utf8");
  const fixture = {
    PORT: String(E2E_PORT),
    SNOBOARD_AUTH_MODES: "password",
    SNOBOARD_PUBLIC_URL: E2E_ORIGIN,
    SNOBOARD_REPO_URL: remote.replaceAll("\\", "/"),
    SNOBOARD_DATA_DIR: dataDir,
    SNOBOARD_PASSWORD_HASH_FILE: hashFile,
    SNOBOARD_SESSION_SECRET_FILE: secretFile,
    SNOBOARD_REFRESH_SECONDS: "3600",
  };
  await writeFile(fixturePath, `${JSON.stringify(fixture)}\n`, "utf8");
}

if (isDirectRun()) {
  await globalSetup();
}

function isDirectRun(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  return samePath(invoked, fileURLToPath(import.meta.url));
}

function samePath(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  if (process.platform === "win32") return resolvedLeft.toLowerCase() === resolvedRight.toLowerCase();
  return resolvedLeft === resolvedRight;
}
