#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRosterSeed } from "./build-roster-seed.mjs";

// Deliberately local-only. Remote execution is a separately reviewed owner step.
if (process.argv.length !== 2) throw new Error("seed:roster accepts no arguments; remote use is documented in docs/roster-seed.adoc");
const root = fileURLToPath(new URL("../", import.meta.url));
const { sql, records } = buildRosterSeed();
if (readFileSync(resolve(root, "seeds/roster.sql"), "utf8") !== sql) {
  throw new Error("Roster SQL is stale. Run node scripts/build-roster-seed.mjs and review the diff first.");
}
const wrangler = resolve(root, "node_modules/wrangler/bin/wrangler.js");
for (const args of [
  ["d1", "migrations", "apply", "DB"],
  ["d1", "execute", "DB", "--file", "seeds/roster.sql"],
]) {
  const result = spawnSync(process.execPath, [wrangler, ...args, "--local", "--config", "scripts/wrangler.roster-local.jsonc"], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`Seed applied locally: ${records.length} source members (existing rows preserved)`);
