#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TARGETS = {
  staging: { file: 'wrangler.staging.jsonc', name: 'ituob-org-staging', origin: 'https://staging-www.ituob.org' },
  production: { file: 'wrangler.jsonc', name: 'ituob-org', origin: 'https://www.ituob.org' },
};
const SECRET_NAMES = ['RESEND_API_KEY', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET'];
const REQUIRED_VARS = ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'MAIL_FROM', 'PATCH_REPO', 'GITHUB_APP_ID', 'GITHUB_APP_INSTALLATION_ID', 'GITHUB_SITE_REPO', 'GITHUB_DATA_GITLINK'];
const OPTIONAL_VARS = ['AUTH_MODE', 'OIDC_CLIENT_AUTH', 'OIDC_SCOPES', 'OIDC_SUB_KEY', 'OIDC_ID_TOKEN_ALGS', 'OIDC_AUTHORIZATION_ENDPOINT', 'OIDC_TOKEN_ENDPOINT', 'OIDC_JWKS_URI', 'OIDC_END_SESSION_ENDPOINT', 'OIDC_REDIRECT_URI', 'OIDC_POST_LOGOUT_REDIRECT_URI', 'GITHUB_STAGING_BRANCH'];
const RESOURCE_KEYS = ['account_id', 'database_id', 'database_name', 'notify_queue', 'dead_letter_queue', 'vars'];
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const text = (value) => typeof value === 'string' && value.trim() === value && value.length > 0;
const uuid = (value) => text(value) && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value);
const resourceName = (value) => text(value) && /^[a-zA-Z0-9_-]{1,63}$/.test(value);
function target(environment) {
  assert(Object.hasOwn(TARGETS, environment), 'Choose --environment staging or production.');
  return TARGETS[environment];
}
function https(value, label) {
  assert(text(value), `${label} is required.`);
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label} must be an HTTPS URL.`); }
  assert(url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.search && url.hostname !== 'localhost' && !url.hostname.endsWith('.localhost') && !['127.0.0.1', '[::1]'].includes(url.hostname), `${label} must be a public HTTPS URL without credentials, query or fragment.`);
  return url;
}
export function requiredSecrets(vars) {
  return [...(vars.OIDC_CLIENT_AUTH === 'none' ? [] : ['OIDC_CLIENT_SECRET']), ...SECRET_NAMES];
}
function validateVars(vars, environment) {
  const { origin } = target(environment);
  assert(vars && typeof vars === 'object' && !Array.isArray(vars), 'vars is required.');
  assert(Object.keys(vars).every((key) => [...REQUIRED_VARS, ...OPTIONAL_VARS].includes(key)), 'vars contains an unsupported key or a secret; provide only documented non-secret vars.');
  assert(Object.values(vars).every(text), 'Every var must be a non-empty trimmed string.');
  assert(vars.AUTH_MODE === 'oidc', 'AUTH_MODE must be oidc; development authentication is forbidden.');
  for (const name of REQUIRED_VARS) assert(text(vars[name]), `${name} is required.`);
  assert(['basic', 'post', 'none'].includes(vars.OIDC_CLIENT_AUTH), 'OIDC_CLIENT_AUTH must be basic, post or none.');
  https(vars.OIDC_ISSUER, 'OIDC_ISSUER');
  for (const key of ['OIDC_AUTHORIZATION_ENDPOINT', 'OIDC_TOKEN_ENDPOINT', 'OIDC_JWKS_URI', 'OIDC_END_SESSION_ENDPOINT']) if (vars[key]) https(vars[key], key);
  assert(vars.OIDC_REDIRECT_URI === `${origin}/auth/callback`, 'OIDC_REDIRECT_URI must match the selected environment callback.');
  if (vars.OIDC_POST_LOGOUT_REDIRECT_URI) assert(https(vars.OIDC_POST_LOGOUT_REDIRECT_URI, 'OIDC_POST_LOGOUT_REDIRECT_URI').origin === origin, 'Logout redirect must stay in the selected environment.');
  if (vars.OIDC_SUB_KEY) assert(['verbatim', 'issuer'].includes(vars.OIDC_SUB_KEY), 'Invalid OIDC_SUB_KEY.');
  if (vars.OIDC_ID_TOKEN_ALGS) assert(vars.OIDC_ID_TOKEN_ALGS.split(',').every((alg) => ['RS256', 'ES256'].includes(alg.trim())), 'Only RS256 and ES256 ID tokens are supported.');
  if (vars.OIDC_SCOPES) assert(vars.OIDC_SCOPES.split(/\s+/).includes('openid'), 'OIDC_SCOPES must include openid.');
  const team = https(vars.ACCESS_TEAM_DOMAIN, 'ACCESS_TEAM_DOMAIN');
  assert(/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team.hostname) && !team.port && team.pathname === '/', 'ACCESS_TEAM_DOMAIN must be a Cloudflare Access team origin.');
  const address = /^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+$/.test(vars.MAIL_FROM)
    || /^[^<>\r\n]+ <[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+>$/.test(vars.MAIL_FROM);
  assert(address, 'MAIL_FROM must contain a valid sender address.');
  for (const key of ['PATCH_REPO', 'GITHUB_SITE_REPO']) assert(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(vars[key]), `${key} must explicitly name owner/repository.`);
  const repositories = { data: 'ituob/itu-ob-data', 'data-ob': 'ituob/service-publications-docs' };
  assert(Object.hasOwn(repositories, vars.GITHUB_DATA_GITLINK), 'GITHUB_DATA_GITLINK must be data or data-ob.');
  assert(vars.PATCH_REPO === repositories[vars.GITHUB_DATA_GITLINK], 'PATCH_REPO must match the selected data gitlink in .gitmodules.');
  assert(/^[A-Za-z0-9_-]+$/.test(vars.GITHUB_APP_ID), 'GITHUB_APP_ID must be an App ID or client ID.');
  assert(/^[1-9][0-9]*$/.test(vars.GITHUB_APP_INSTALLATION_ID), 'GITHUB_APP_INSTALLATION_ID must be numeric.');
  if (vars.GITHUB_STAGING_BRANCH) {
    const branch = vars.GITHUB_STAGING_BRANCH;
    assert(branch !== '@' && !branch.startsWith('-') && !/[\s\x00-\x1f\x7f~^:?*\[\\]/.test(branch) && !branch.includes('..') && !branch.includes('@{')
      && branch.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock')), 'Invalid GITHUB_STAGING_BRANCH.');
  }
}

/** Validate local declarations only. Remote resources, migration state and secret values require authenticated checks. */
export function validateConfig(config, environment, expectedAccount) {
  const selected = target(environment);
  assert(config.name === selected.name && config.main === 'worker/index.ts', 'Worker name/main does not match the selected environment.');
  assert(text(config.account_id) && /^[0-9a-f]{32}$/i.test(config.account_id) && !/^0{32}$/.test(config.account_id), 'An explicit Cloudflare account_id is required (32 hex characters).');
  if (expectedAccount) assert(config.account_id === expectedAccount, 'Config account_id differs from CLOUDFLARE_ACCOUNT_ID.');
  assert(config.workers_dev === false, 'workers_dev must remain disabled for the configured custom domains.');
  const hosts = environment === 'production' ? ['www.ituob.org', 'ituob.org'] : ['staging-www.ituob.org'];
  assert(Array.isArray(config.routes) && config.routes.length === hosts.length && hosts.every((host) => config.routes.some((route) => route.pattern === host && route.custom_domain === true)), 'Custom domains must match the selected environment.');
  assert(config.assets?.binding === 'ASSETS' && config.assets?.directory === './dist' && config.assets?.run_worker_first === true && config.run_worker_first === undefined, 'ASSETS must run the Worker first; run_worker_first belongs inside assets.');
  assert(config.assets.html_handling === 'auto-trailing-slash' && config.assets.not_found_handling === '404-page', 'Preserve static asset routing and 404 handling.');
  const db = config.d1_databases;
  assert(Array.isArray(db) && db.length === 1 && db[0].binding === 'DB', 'Exactly one D1 DB binding is required.');
  assert(uuid(db[0].database_id) && resourceName(db[0].database_name) && db[0].migrations_dir === 'migrations', 'D1 requires an explicit database UUID/name and migrations directory.');
  const producers = config.queues?.producers, consumers = config.queues?.consumers;
  assert(Array.isArray(producers) && producers.length === 1 && producers[0].binding === 'NOTIFY_Q' && resourceName(producers[0].queue), 'Exactly one NOTIFY_Q producer with an explicit queue name is required.');
  assert(Array.isArray(consumers) && consumers.length === 1 && consumers[0].queue === producers[0].queue, 'Queue consumer must consume the NOTIFY_Q producer queue.');
  assert(resourceName(consumers[0].dead_letter_queue) && consumers[0].dead_letter_queue !== consumers[0].queue, 'A distinct dead-letter queue is required.');
  assert(consumers[0].max_retries === 5 && consumers[0].max_batch_size === 10 && consumers[0].max_batch_timeout === 5, 'Queue retry/batch settings must match the delivery policy.');
  assert(config.triggers?.crons?.length === 1 && config.triggers.crons[0] === '*/5 * * * *', 'A five-minute sweep/reconciliation schedule is required.');
  validateVars(config.vars, environment);
  assert(Array.isArray(config.secrets?.required) && requiredSecrets(config.vars).every((name) => config.secrets.required.includes(name)), 'Declare all required provider secret names with secrets.required.');
  return config;
}
export function validateIsolation(left, right) {
  // An unconfigured peer template has no resource identity to compare yet.
  if (!left || !right) return;
  const ldb = left.d1_databases?.[0]?.database_id, rdb = right.d1_databases?.[0]?.database_id;
  assert(!ldb || !rdb || ldb !== rdb, 'Staging and production must not share a D1 database.');
  const lqueues = [...(left.queues?.producers ?? []).map((q) => q.queue), ...(left.queues?.consumers ?? []).map((q) => q.dead_letter_queue)];
  const rqueues = [...(right.queues?.producers ?? []).map((q) => q.queue), ...(right.queues?.consumers ?? []).map((q) => q.dead_letter_queue)];
  if (left.account_id === right.account_id) assert(!lqueues.some((queue) => queue && rqueues.includes(queue)), 'Staging and production must not share notification or dead-letter queues.');
  assert(!left.vars?.ACCESS_AUD || !right.vars?.ACCESS_AUD || left.vars.ACCESS_AUD !== right.vars.ACCESS_AUD, 'Staging and production must use separate Access application audiences.');
}
export function buildConfig(resources, environment, base) {
  target(environment);
  assert(resources && typeof resources === 'object' && !Array.isArray(resources), 'Selected environment resources are required.');
  assert(Object.keys(resources).every((key) => RESOURCE_KEYS.includes(key)), 'Resources contain an unsupported key; do not supply secrets.');
  const config = structuredClone(base);
  delete config.run_worker_first;
  config.assets = { ...config.assets, run_worker_first: true };
  config.account_id = resources.account_id;
  config.d1_databases = [{ binding: 'DB', database_name: resources.database_name, database_id: resources.database_id, migrations_dir: 'migrations' }];
  config.queues = { producers: [{ binding: 'NOTIFY_Q', queue: resources.notify_queue }], consumers: [{ queue: resources.notify_queue, dead_letter_queue: resources.dead_letter_queue, max_batch_size: 10, max_batch_timeout: 5, max_retries: 5 }] };
  config.triggers = { crons: ['*/5 * * * *'] };
  config.vars = { AUTH_MODE: 'oidc', OIDC_CLIENT_AUTH: 'basic', GITHUB_STAGING_BRANCH: 'staging', ...resources.vars, OIDC_REDIRECT_URI: resources.vars?.OIDC_REDIRECT_URI ?? `${TARGETS[environment].origin}/auth/callback` };
  config.secrets = { required: requiredSecrets(config.vars) };
  return validateConfig(config, environment);
}
function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new Error(`Cannot read valid JSON from ${file}. Keep generated .jsonc files as JSON.`); }
}
export function main(args, root = ROOT) {
  let environment, input, write = false, check = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--environment') environment = args[++i];
    else if (arg === '--input') input = args[++i];
    else if (arg === '--write') write = true;
    else if (arg === '--check') check = true;
    else throw new Error('Usage: --environment staging|production [--input resources.json [--write] | --check]');
  }
  const selected = target(environment);
  assert(!(check && (input || write)), '--check cannot be combined with --input or --write.');
  const peerEnv = environment === 'staging' ? 'production' : 'staging';
  const base = readJson(resolve(root, selected.file));
  const peer = readJson(resolve(root, TARGETS[peerEnv].file));
  if (check) {
    validateConfig(base, environment, process.env.CLOUDFLARE_ACCOUNT_ID);
    validateIsolation(base, peer);
    return `Local ${environment} deployment declarations passed. Remote resources, migrations and secret values are not checked.\n`;
  }
  assert(input, '--input is required; generation is a dry run unless --write is supplied.');
  const manifest = readJson(resolve(input));
  assert(manifest && typeof manifest === 'object' && !Array.isArray(manifest) && Object.keys(manifest).every((key) => Object.hasOwn(TARGETS, key)), 'Manifest must contain staging and/or production resources only.');
  const config = buildConfig(manifest[environment], environment, base);
  const peerConfig = manifest[peerEnv] ? buildConfig(manifest[peerEnv], peerEnv, peer) : peer;
  validateIsolation(config, peerConfig);
  if (process.env.CLOUDFLARE_ACCOUNT_ID) assert(config.account_id === process.env.CLOUDFLARE_ACCOUNT_ID, 'Config account_id differs from CLOUDFLARE_ACCOUNT_ID.');
  const output = `${JSON.stringify(config, null, 2)}\n`;
  if (write) writeFileSync(resolve(root, selected.file), output);
  return output;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(main(process.argv.slice(2))); }
  catch (error) { process.stderr.write(`Cloudflare configuration: ${error.message}\n`); process.exitCode = 1; }
}
