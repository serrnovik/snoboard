import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const appRoot = process.argv[2];
if (!appRoot) {
  console.error("usage: node prune-runtime.mjs <app-root>");
  process.exit(1);
}

const dist = path.join(appRoot, "dist");
const nm = path.join(appRoot, "node_modules");
const pnpm = path.join(nm, ".pnpm");
const require = createRequire(path.join(dist, "server", "index.mjs"));
const specifierRe =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\(\s*)["']([^"']+)["']/g;

function specifiers(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const found = [];
  for (const match of text.matchAll(specifierRe)) {
    const spec = match[1];
    if (
      spec.startsWith("node:") ||
      spec.startsWith("virtual:") ||
      spec.startsWith("data:")
    ) {
      continue;
    }
    found.push(spec);
  }
  return found;
}

function resolveFrom(spec, fromFile) {
  try {
    return require.resolve(spec, { paths: [path.dirname(fromFile)] });
  } catch {
    return undefined;
  }
}

const seenFiles = new Set();
const storeKeep = new Set();
const queue = [path.join(dist, "server", "index.mjs")];

while (queue.length > 0) {
  const file = queue.pop();
  if (file === undefined || seenFiles.has(file)) continue;
  seenFiles.add(file);
  const real = fs.existsSync(file) ? fs.realpathSync(file) : file;
  const rel = path.relative(pnpm, real);
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
    const store = rel.split(path.sep)[0];
    if (store) storeKeep.add(store);
  }
  for (const spec of specifiers(file)) {
    const resolved = resolveFrom(spec, file);
    if (resolved !== undefined) queue.push(resolved);
  }
}

let removed = 0;
for (const name of fs.readdirSync(pnpm)) {
  const target = path.join(pnpm, name);
  if (!fs.statSync(target).isDirectory()) continue;
  if (storeKeep.has(name)) continue;
  fs.rmSync(target, { recursive: true, force: true });
  removed += 1;
}

function bytes(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) total += bytes(target);
    else total += fs.statSync(target).size;
  }
  return total;
}

console.log(
  `kept ${storeKeep.size} store entries, removed ${removed}, node_modules ${(bytes(nm) / 1e6).toFixed(1)} MB`,
);
