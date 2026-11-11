import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { readFileSync, readdirSync } from "node:fs";
import { defineConfig } from "vitest/config";

// Worker tests run in workerd via miniflare with a REAL local D1 (no mocks).
// The test harness declares its own bindings: wrangler*.jsonc stay free of
// any D1 binding or AUTH_MODE (see test/stub-production.test.ts).
export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  // The test runs inside workerd (no real fs), so hand it the deploy configs' text.
  const wranglerConfigs = Object.fromEntries(
    readdirSync(".").filter((f) => /^wrangler.*\.jsonc?$/.test(f)).map((f) => [f, readFileSync(f, "utf8")]),
  );
  return {
    plugins: [
      cloudflareTest({
        main: "./worker/index.ts",
        miniflare: {
          compatibilityDate: "2026-10-01",
          d1Databases: ["DB"],
          queueProducers: { NOTIFY_Q: "ituob-notify" },
          bindings: { AUTH_MODE: "stub", GITHUB_WEBHOOK_SECRET: "test-webhook-secret", TEST_MIGRATIONS: migrations, WRANGLER_CONFIGS: wranglerConfigs },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/setup.ts"],
    },
  };
});
