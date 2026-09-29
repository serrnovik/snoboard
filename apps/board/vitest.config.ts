import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${path.resolve(root, "src")}/` },
      { find: /^snoboard\/browser$/, replacement: path.resolve(root, "../../packages/core/src/browser.ts") },
      { find: /^snoboard$/, replacement: path.resolve(root, "../../packages/core/src/index.ts") },
    ],
  },
  test: {
    include: ["server/**/*.test.ts", "src/**/*.test.ts", "src/**/*.test.tsx"],
    fileParallelism: false,
  },
});
