import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Git fixtures share the machine with the board suite (`pnpm test` runs
    // both packages at once). A few history walks sit just over the 5s default.
    testTimeout: 20_000,
  },
});
