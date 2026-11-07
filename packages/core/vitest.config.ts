import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Git fixtures spawn many short git processes. The root `pnpm test` runs the
    // packages one at a time so this suite does not compete with the board's.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
