import { defineConfig, devices } from "@playwright/test";
import { E2E_ORIGIN } from "./e2e/constants.ts";

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: E2E_ORIGIN,
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
  },
  webServer: {
    command: "node e2e/global-setup.ts && node e2e/start-server.mjs",
    url: `${E2E_ORIGIN}/healthz`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
});
