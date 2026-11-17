// Asserts every Cloudflare binding the Worker code uses is declared in BOTH
// deploy configs (docs/cloudflare-bindings.adoc). Run: npm run check:bindings
//
// "Used" is derived from the code, not a hand list:
//   - worker/lib/types.ts `Env` members typed D1Database / Queue<...>
//   - worker/index.ts exporting `queue` (needs a queue consumer) and
//     `scheduled` (needs a cron trigger)
// It also refuses AUTH_MODE / stub / secrets in the configs (see
// test/stub-production.test.ts): email and identity stay config keys only.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const jsonc = (p) => JSON.parse(read(p).split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n"));

const types = read("worker/lib/types.ts");
const envBody = types.slice(types.indexOf("export interface Env"), types.indexOf("\n}", types.indexOf("export interface Env")));
const members = [...envBody.matchAll(/^\s*([A-Z][A-Z0-9_]*)\??:\s*([^;]+);/gm)].map((m) => ({ name: m[1], type: m[2].trim() }));
const d1 = members.filter((m) => /^D1Database\b/.test(m.type)).map((m) => m.name);
const producers = members.filter((m) => /^Queue</.test(m.type)).map((m) => m.name);
const index = read("worker/index.ts");
const hasQueue = /^\s*queue\s*[:(]/m.test(index);
const hasScheduled = /^\s*(async\s+)?scheduled\s*\(/m.test(index);

export function check(file, cfg) {
  const errs = [];
  const dbs = cfg.d1_databases ?? [];
  for (const b of d1) {
    const e = dbs.find((x) => x.binding === b);
    if (!e) errs.push(`${file}: D1 binding ${b} (used by worker code) is not declared in d1_databases`);
    else if (!e.database_name || !e.database_id) errs.push(`${file}: D1 binding ${b} needs database_name and database_id`);
  }
  const prods = cfg.queues?.producers ?? [];
  for (const b of producers) {
    if (!prods.some((x) => x.binding === b && x.queue)) errs.push(`${file}: queue producer ${b} is not declared in queues.producers`);
  }
  if (hasQueue) {
    const cons = cfg.queues?.consumers ?? [];
    const names = prods.map((p) => p.queue);
    for (const q of names) if (!cons.some((c) => c.queue === q)) errs.push(`${file}: worker exports queue() but queue ${q} has no entry in queues.consumers`);
    if (!names.length) errs.push(`${file}: worker exports queue() but no queue is declared`);
  }
  if (hasScheduled && !(cfg.triggers?.crons ?? []).length) errs.push(`${file}: worker exports scheduled() but triggers.crons is empty`);
  const text = JSON.stringify(cfg);
  if (/AUTH_MODE|stub/i.test(text)) errs.push(`${file}: must not set AUTH_MODE or stub`);
  return errs;
}

const files = ["wrangler.jsonc", "wrangler.staging.jsonc"];
const cfgs = files.map((f) => [f, jsonc(f)]);
const errs = cfgs.flatMap(([f, c]) => check(f, c));
// Prod and staging must never share a database or queue.
const ids = (c) => [...(c.d1_databases ?? []).map((d) => d.database_id), ...(c.d1_databases ?? []).map((d) => d.database_name), ...(c.queues?.producers ?? []).map((q) => q.queue)];
const shared = ids(cfgs[0][1]).filter((x) => ids(cfgs[1][1]).includes(x));
if (shared.length) errs.push(`production and staging share resources: ${shared.join(", ")}`);
if (!d1.length || !producers.length) errs.push("derivation found no D1/Queue bindings in worker/lib/types.ts Env: check scripts/check-bindings.mjs");

if (errs.length) { console.error(errs.join("\n")); process.exit(1); }
console.log(`bindings ok: D1 [${d1}] queue producers [${producers}] queue()=${hasQueue} scheduled()=${hasScheduled} in ${files.join(", ")}`);
