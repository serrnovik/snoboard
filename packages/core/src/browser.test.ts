import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = path.dirname(fileURLToPath(import.meta.url));

/** Value imports (not `import type`) reachable from `entry`, following relative modules. */
function reachableImports(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    const text = readFileSync(path.join(srcDir, file), "utf8");
    const specifiers: string[] = [];
    for (const match of text.matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gms)) {
      specifiers.push(match[1] as string);
    }
    seen.set(file, specifiers);
    for (const specifier of specifiers) {
      if (specifier.startsWith("./")) queue.push(specifier.slice(2).replace(/\.js$/, ".ts"));
    }
  }
  return seen;
}

describe("snoboard/browser", () => {
  it("pulls in no Node built-ins, so the web bundle builds", () => {
    const offenders = [...reachableImports("browser.ts")].flatMap(([file, specifiers]) =>
      specifiers.filter((specifier) => specifier.startsWith("node:")).map((specifier) => `${file} -> ${specifier}`),
    );
    expect(offenders).toEqual([]);
  });
});
