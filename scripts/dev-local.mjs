#!/usr/bin/env node
// Local-only HTTPS entry point. Production Worker cookie policy is unchanged.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { personaSql } from './mock-idp.mjs';
import { demoSeedSql } from './demo-seed.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const legacyRedirects = JSON.parse(readFileSync(resolve(root, 'worker/lib/legacy-redirects.json'), 'utf8'));
// Mirror worker/lib/legacy-redirects.ts so only mapped HTML aliases reach the Worker.
function legacyRedirectTarget(pathname) {
  if (/%2f|%5c/i.test(pathname)) return null;
  let path;
  try { path = decodeURIComponent(pathname); } catch { return null; }
  path = path.replace(/\/index\.html$/, '/');
  if (!path.endsWith('/')) path += '/';
  return legacyRedirects[path] ?? null;
}
const state = resolve(root, '.local-dev');
// DEV_LOCAL_PORT_OFFSET lets a second instance run beside another one (used by test:visual).
const shift = Number(process.env.DEV_LOCAL_PORT_OFFSET || 0);
const ports = { https: 8443 + shift, astro: 14321 + shift, worker: 18787 + shift, idp: 18788 + shift };
const origin = `https://127.0.0.1:${ports.https}`;
mkdirSync(state, { recursive: true });
const key = resolve(state, 'key.pem'), cert = resolve(state, 'cert.pem');
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, CI: '1' } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
}
if (!existsSync(key) || !existsSync(cert)) {
  const opensslConfig = resolve(state, 'openssl.cnf');
  writeFileSync(opensslConfig, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n');
  run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-keyout', key, '-out', cert, '-config', opensslConfig]);
}
const config = resolve(state, 'wrangler.json');
writeFileSync(config, JSON.stringify({
  name: 'ituob-local-demo', main: '../worker/index.ts', compatibility_date: '2026-10-01',
  vars: { AUTH_MODE: 'oidc', LOCAL_DEMO: '1', DEMO_CATALOG_REGISTERS: readFileSync(resolve(root, 'data-ob/catalogs/registers.yaml'), 'utf8'), DEMO_CATALOG_RECOMMENDATIONS: readFileSync(resolve(root, 'data-ob/catalogs/recommendations.yaml'), 'utf8'), OIDC_ISSUER: `http://127.0.0.1:${ports.idp}`, OIDC_CLIENT_ID: 'ituob-local-dev', OIDC_CLIENT_SECRET: 'local-dev-secret-not-real', OIDC_CLIENT_AUTH: 'basic', OIDC_AUTHORIZATION_ENDPOINT: `${origin}/authorize`, OIDC_REDIRECT_URI: `${origin}/auth/callback` },
  d1_databases: [{ binding: 'DB', database_name: 'ituob-local-demo', database_id: '00000000-0000-0000-0000-000000000137', migrations_dir: '../migrations' }],
}));
writeFileSync(resolve(state, 'personas.sql'), personaSql());
writeFileSync(resolve(state, 'demo-seed.sql'), demoSeedSql());
const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
const persistence = resolve(state, 'db');
for (const args of [
  ['d1', 'migrations', 'apply', 'DB'],
  ['d1', 'execute', 'DB', '--file', resolve(state, 'personas.sql')],
  ['d1', 'execute', 'DB', '--file', 'seeds/roster.sql'],
  ['d1', 'execute', 'DB', '--file', resolve(state, 'demo-seed.sql')],
]) run(process.execPath, [wrangler, ...args, '--local', '--config', config, '--persist-to', persistence]);

// Generated demo content, all gitignored: register snapshots (as CI does, build-deploy.yml) and the
// downloads manifest + PDFs. First run takes ~2 minutes; later runs reuse them. A failure only warns.
function prepare(label, ready, command, args) {
  if (ready) return;
  console.log(`dev:local: generating ${label} (one-time)...`);
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error || result.status !== 0) console.warn(`dev:local: WARNING ${label} could not be generated; related pages will be incomplete.`);
}
const gitHead = dir => spawnSync('git', ['rev-parse', 'HEAD'], { cwd: resolve(root, dir), encoding: 'utf8' }).stdout.trim();
const projection = resolve(state, 'projection');
prepare('register snapshots', existsSync(resolve(root, 'data/snapshots')) && existsSync(projection), 'python3', ['scripts/project-authored-data.py', '--data-root', 'data', '--service-root', 'data-ob', '--data-ref', gitHead('data'), '--service-ref', gitHead('data-ob'), '--snapshots-out', 'data/snapshots', '--projection-root', projection]);
prepare('downloads manifest and PDFs', existsSync(resolve(root, 'src/data/publications-manifest.json')), process.execPath, ['--experimental-strip-types', 'scripts/fetch-publications.ts', 'fetch']);

const children = [];
let stopping = false;
let server;
const sockets = new Set();
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  server?.close();
  for (const socket of sockets) socket.destroy();
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop());
function start(args) {
  const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ASTRO_DEV_BACKGROUND: '1', ITUOB_DEV_LOCAL: '1', ...(existsSync(projection) ? { OB_DATA_ROOT: projection } : {}) } });
  children.push(child);
  child.on('error', error => { console.error(error); stop(1); });
  child.on('exit', code => { if (!stopping) stop(code || 1); });
}
start([resolve(root, 'node_modules/astro/bin/astro.mjs'), 'dev', '--ignore-lock', '--host', '127.0.0.1', '--port', String(ports.astro)]);
start([resolve(root, 'scripts/mock-idp.mjs'), 'serve', String(ports.idp)]);
start([wrangler, 'dev', '--local', '--config', config, '--persist-to', persistence, '--ip', '127.0.0.1', '--port', String(ports.worker), '--local-protocol', 'https', '--https-key-path', key, '--https-cert-path', cert]);

server = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
  const path = new URL(req.url, origin).pathname;
  const worker = /^\/(api|auth)(\/|$)/.test(path) || legacyRedirectTarget(path) !== null;
  const provider = path === '/authorize';
  const transport = worker ? https : http;
  const upstream = transport.request({ hostname: '127.0.0.1', port: worker ? ports.worker : provider ? ports.idp : ports.astro, path: req.url, method: req.method, headers: req.headers, ...(worker ? { ca: readFileSync(cert) } : {}) }, incoming => {
    res.writeHead(incoming.statusCode, incoming.headers);
    incoming.pipe(res);
  });
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(503, { 'Content-Type': 'text/plain' }); res.end('Local services are starting. Refresh shortly.'); });
  req.pipe(upstream);
});
// Keep Vite hot reload on the same HTTPS origin as the page.
server.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(ports.astro, '127.0.0.1', () => {
    upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${req.rawHeaders.reduce((lines, value, i) => i % 2 ? lines + value + '\r\n' : lines + value + ': ', '')}\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  sockets.add(socket);
  socket.on('close', () => { sockets.delete(socket); upstream.destroy(); });
  socket.on('error', () => upstream.destroy());
  upstream.on('error', () => socket.destroy());
});
server.on('error', error => { console.error(error); stop(1); });
server.listen(ports.https, '127.0.0.1', () => console.log(`Local demo: ${origin} — accept the local self-signed certificate once. Ctrl-C stops all services.`));
