import { defineConfig } from "@playwright/test";

// Visual/accessibility checks against `npm run dev:local` (https://127.0.0.1:8443, mock IdP).
// Shifted so it can run beside another dev:local instance on the default 8443.
const offset = Number(process.env.DEV_LOCAL_PORT_OFFSET ?? 1000);
const origin = `https://127.0.0.1:${8443 + offset}`;

export default defineConfig({
  testDir: "./tests/visual",
  testMatch: /.*\.pw\.ts/,
  outputDir: "./test-results",
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: [["list"]],
  use: { baseURL: origin, ignoreHTTPSErrors: true, trace: "off" },
  webServer: {
    command: "npm run dev:local",
    env: { DEV_LOCAL_PORT_OFFSET: String(offset) },
    url: `${origin}/`,
    ignoreHTTPSErrors: true,
    reuseExistingServer: !!process.env.PW_REUSE_SERVER,
    timeout: 420_000,
  },
});
