import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, deriveBindings, parseJsonc, validate } from "../scripts/check-bindings.mjs";

const bindings = { d1: ["DB"], producers: ["NOTIFY_Q"], hasQueue: true, hasScheduled: true };
const config = (suffix = "prod") => ({
  d1_databases: [{ binding: "DB", database_name: `db-${suffix}`, database_id: suffix === "prod" ? "00000000-0000-0000-0000-000000000000" : "00000000-0000-0000-0000-000000000001" }],
  queues: { producers: [{ binding: "NOTIFY_Q", queue: `notify-${suffix}` }], consumers: [{ queue: `notify-${suffix}` }] },
  triggers: { crons: ["*/5 * * * *"] },
});

interface Fixture {
  root: string;
  write(path: string, value: unknown): void;
}

function fixture(run: (fixture: Fixture) => void, { types = "export interface Env { DB: D1Database; NOTIFY_Q?: Queue<unknown>; }", extra = "", handlers = "async queue(batch: unknown, env: Env) {}, scheduled: async (event: unknown, env: Env) => {}" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "bindings-test-"));
  const write: Fixture["write"] = (path, value) => writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value));
  mkdirSync(join(root, "worker/lib"), { recursive: true });
  write("worker/tsconfig.json", { compilerOptions: { strict: true, types: [], moduleResolution: "bundler", module: "esnext", allowImportingTsExtensions: true }, include: ["**/*.ts"] });
  write("worker/globals.d.ts", "interface D1Database { prepare(sql: string): unknown } interface Queue<T> { send(value: T): Promise<void> }");
  write("worker/lib/types.ts", types);
  write("worker/extra.ts", extra);
  write("worker/index.ts", `import type { Env } from './lib/types.ts'; export default { async fetch(request: unknown, env: Env) {}, ${handlers} };`);
  write("wrangler.jsonc", {});
  write("wrangler.staging.jsonc", {});
  write("wrangler.bindings.example.jsonc", config());
  write("wrangler.staging.bindings.example.jsonc", config("staging"));
  try { return run({ root, write }); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("compiler derives lowercase, readonly, optional, aliased and inherited bindings across files", () => fixture(({ root }) => {
  const found = deriveBindings(root);
  assert.deepEqual(found.d1.sort(), ["DB", "auditDb", "inheritedDb", "readonlyDb"].sort());
  assert.deepEqual(found.producers.sort(), ["NOTIFY_Q", "auditQueue", "inheritedQueue"].sort());
  const errors = check("example", config(), found).join("\n");
  for (const binding of ["auditDb", "inheritedDb", "readonlyDb", "auditQueue", "inheritedQueue"]) assert.match(errors, new RegExp(`binding ${binding}|producer ${binding}`));
}, {
  types: `import type { ExtraBindings } from '../extra.ts';
    type DatabaseAlias = D1Database; type QueueAlias = Queue<unknown>;
    export interface Env extends ExtraBindings { DB: D1Database; NOTIFY_Q?: Queue<unknown>; auditDb?: DatabaseAlias; readonly readonlyDb?: D1Database; readonly auditQueue?: QueueAlias; }`,
  extra: "export interface ExtraBindings { inheritedDb: D1Database; inheritedQueue: Queue<unknown>; }",
}));

test("compiler follows the runtime Env import to another file and ignores unrelated Env declarations", () => fixture(({ root, write }) => {
  write("worker/runtime.ts", "export interface Env { DB: D1Database; NOTIFY_Q: Queue<unknown>; movedDb: D1Database; }");
  write("worker/index.ts", "import type { Env } from './runtime.ts'; export default { fetch(request: unknown, env: Env) {} };");
  assert.deepEqual(deriveBindings(root).d1.sort(), ["DB", "movedDb"]);
}));

test("default async queue method and scheduled arrow require consumers and crons", () => fixture(({ root }) => {
  const found = deriveBindings(root);
  assert.equal(found.hasQueue, true);
  assert.equal(found.hasScheduled, true);
  const cfg = config();
  cfg.queues.consumers = [];
  cfg.triggers.crons = [];
  const errors = check("example", cfg, found).join("\n");
  assert.match(errors, /no entry in queues.consumers/);
  assert.match(errors, /triggers.crons is empty/);
}));

test("unrelated queue and scheduled functions do not enable default handlers", () => fixture(({ root, write }) => {
  write("worker/index.ts", "import type { Env } from './lib/types.ts'; const unrelated = { queue() {}, scheduled() {} }; const worker = { fetch(request: unknown, env: Env) {} }; export default worker;");
  const found = deriveBindings(root);
  assert.equal(found.hasQueue, false);
  assert.equal(found.hasScheduled, false);
}));

test("valid baseline keeps live deployments disabled while validating complete examples", () => fixture(({ root }) => {
  assert.deepEqual(validate(root).errs, []);
}));

test("live D1, producer, consumer and cron entries are rejected, including named environments", () => fixture(({ root, write }) => {
  for (const resource of [
    { d1_databases: config().d1_databases },
    { queues: { producers: config().queues.producers } },
    { queues: { consumers: config().queues.consumers } },
    { triggers: config().triggers },
  ]) {
    write("wrangler.jsonc", { env: { hidden: resource } });
    assert.match(validate(root).errs.join("\n"), /live deployment must not enable/);
  }
}));

test("production and staging cannot share consumer-only queues", () => fixture(({ root, write }) => {
  const prod = config();
  const staging = config("staging");
  prod.queues.consumers.push({ queue: "shared-consumer" });
  staging.queues.consumers.push({ queue: "shared-consumer" });
  write("wrangler.bindings.example.jsonc", prod);
  write("wrangler.staging.bindings.example.jsonc", staging);
  assert.match(validate(root).errs.join("\n"), /share resources: shared-consumer/);
}));

test("credentials in plain vars are rejected while public identity/email configuration is preserved", () => {
  for (const key of ["OIDC_CLIENT_SECRET", "EMAIL_API_KEY", "GITHUB_WEBHOOK_SECRET", "GITHUB_APP_PRIVATE_KEY", "API_TOKEN", "PASSWORD"]) {
    assert.match(check("example", { ...config(), vars: { [key]: "fake" } }, bindings).join("\n"), new RegExp(`secret ${key}`));
  }
  assert.deepEqual(check("example", { ...config(), vars: { OIDC_CLIENT_ID: "public", OIDC_TOKEN_ENDPOINT: "https://example.org/token", EMAIL_API_URL: "https://example.org/email" } }, bindings), []);
});

test("AUTH_MODE and stub remain forbidden in configs", () => {
  assert.match(check("example", { ...config(), vars: { AUTH_MODE: "oidc" } }, bindings).join("\n"), /AUTH_MODE or stub/);
  assert.match(check("example", { ...config(), vars: { EMAIL_PROVIDER: "stub" } }, bindings).join("\n"), /AUTH_MODE or stub/);
});

test("JSONC accepts inline/block comments, trailing commas and comment-like strings", () => {
  const parsed = parseJsonc("example.jsonc", `{
    // whole-line comment
    "url": "https://example.org/a//b", /* block comment */
    "items": [1, 2,], // inline comment
  }`);
  assert.deepEqual(parsed, { url: "https://example.org/a//b", items: [1, 2] });
});

test("JSONC rejects malformed input instead of silently recovering", () => {
  for (const text of ['{"x":}', '{x: 1}', '{"x":1 "y":2}', '{"x":1} garbage', '/* unterminated', '[1,2]']) assert.throws(() => parseJsonc("bad.jsonc", text), /bad.jsonc/);
});

test("invalid database UUIDs fail while example placeholder UUIDs remain accepted", () => {
  const cfg = config();
  cfg.d1_databases[0]!.database_id = "not-a-uuid";
  assert.match(check("example", cfg, bindings).join("\n"), /UUID database_id/);
  assert.deepEqual(check("example", config(), bindings), []);
});
