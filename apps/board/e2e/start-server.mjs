import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const boardRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(os.tmpdir(), "snoboard-e2e-fixture.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
// GitHub is replaced by the local bare remote for edit submits (e2e only).
const preload = pathToFileURL(path.join(boardRoot, "e2e/fake-github.mjs")).href;
const child = spawn(process.execPath, ["--import", preload, path.join(boardRoot, "dist/server/index.mjs")], {
  cwd: boardRoot,
  stdio: "inherit",
  env: { ...process.env, ...fixture },
  windowsHide: true,
});

function stop() {
  child.kill();
}

process.on("SIGTERM", stop);
process.on("SIGINT", stop);
child.on("exit", (code, signal) => {
  if (signal !== null) process.exit(1);
  process.exit(code ?? 1);
});
