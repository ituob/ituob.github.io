import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { readFileSync, readdirSync } from "node:fs";
import { defineConfig } from "vitest/config";
import { parse } from "yaml";
import { countryData, countryLabels } from "./scripts/country-data.mjs";
import { buildCountryMembers, countryMembersSource } from "./scripts/build-country-members.mjs";
import { buildRosterSeed } from "./scripts/build-roster-seed.mjs";

// Worker tests run in workerd via miniflare with a REAL local D1 (no mocks).
// The test harness declares its own bindings (local D1 + queue producer);
// opt-in example configs describe provisioned resources (docs/cloudflare-bindings.adoc,
// npm run check:bindings) and must stay free of AUTH_MODE (test/stub-production.test.ts).
export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  // Generate/read on the host: workerd deliberately has no filesystem access.
  const rosterSeed = await buildRosterSeed("./data-ob");
  const sourceCountries = parse(readFileSync("./data-ob/datasets/country-names/data.yaml", "utf8"))
    .map((row: { key: string; name: { en: string } }) => ({ id: row.key, name: row.name.en.trim(), register_key: row.name.en.trim() }))
    .sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id));
  const countryCoverage = {
    generated: countryMembersSource(buildCountryMembers("./data-ob")),
    committed: readFileSync("./worker/lib/country-members.generated.ts", "utf8"),
    datasets: countryData("./data-ob").map(dataset => ({
      register: dataset.register,
      labels: [...new Set(dataset.rows.flatMap(row => dataset.fields.flatMap(field => countryLabels(row[field]))))].sort(),
    })),
  };
  const testRosterSeed = {
    generatedSql: rosterSeed.sql,
    repeatedSql: (await buildRosterSeed("./data-ob")).sql,
    committedSql: readFileSync("./seeds/roster.sql", "utf8"),
    records: rosterSeed.records,
    sourceCountries,
  };
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
          bindings: { AUTH_MODE: "stub", GITHUB_WEBHOOK_SECRET: "test-webhook-secret", TEST_MIGRATIONS: migrations, WRANGLER_CONFIGS: wranglerConfigs, TEST_ROSTER_SEED: testRosterSeed, TEST_COUNTRY_COVERAGE: countryCoverage },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      // Protocol/host-config tests have a separate Node runner; D1 integration
      // stays here, inside workerd with real migrations and request handling.
      exclude: ["test/deployment-config.test.ts", "test/publisher.test.ts", "test/access.test.ts", "test/email.test.ts", "test/mock-idp-ignore.test.ts", "test/mock-idp-server.test.ts"],
      setupFiles: ["./test/setup.ts"],
    },
  };
});
