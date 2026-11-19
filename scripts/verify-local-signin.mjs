#!/usr/bin/env node
// Run against npm run dev:local; no manually injected cookies or remote requests.
import assert from 'node:assert/strict';
import https from 'node:https';
import { readFileSync } from 'node:fs';
const origin = 'https://127.0.0.1:8443';
const ca = readFileSync(new URL('../.local-dev/cert.pem', import.meta.url));
class CookieJar {
  cookies = new Map();
  accept(url, line) {
    const [pair, ...attributes] = line.split(';');
    const attrs = attributes.map(a => a.trim().toLowerCase());
    const secure = attrs.includes('secure');
    if (secure && new URL(url).protocol !== 'https:') return;
    const equals = pair.indexOf('='), name = pair.slice(0, equals), value = pair.slice(equals + 1);
    if (name.startsWith('__Host-') && (!secure || !attrs.includes('path=/') || attrs.some(a => a.startsWith('domain=')))) return;
    if (!value || attrs.includes('max-age=0')) this.cookies.delete(name);
    else this.cookies.set(name, { value, secure });
  }
  header(url) {
    return [...this.cookies].filter(([, c]) => !c.secure || new URL(url).protocol === 'https:').map(([n, c]) => `${n}=${c.value}`).join('; ');
  }
}
const rejected = new CookieJar();
rejected.accept('http://127.0.0.1', '__Host-ituob_flow=example; Path=/; Secure; HttpOnly; SameSite=Lax');
assert.equal(rejected.cookies.size, 0, 'Secure cookies must be rejected over HTTP');
async function request(jar, path, { method = 'GET', body, originHeader = origin } = {}) {
  const url = new URL(path, origin);
  assert.equal(url.origin, origin, 'Proof must stay on the single loopback HTTPS origin');
  return new Promise((resolve, reject) => {
    const req = https.request(url, { ca, method, headers: {
      Cookie: jar.header(url), ...(method === 'POST' ? { Origin: originHeader, 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    } }, res => {
      for (const cookie of res.headers['set-cookie'] ?? []) jar.accept(url, cookie);
      let text = ''; res.setEncoding('utf8'); res.on('data', c => text += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);req.end(body);
  });
}
for (const [persona, email, roles, memberStateId] of [
  ['member-aland', 'delegate@aland.mock.test', ['member-submitter'], 'MOCK-A'],
  ['itu-admin', 'itu-admin@mock.test', ['itu-admin'], null],
  ['member-suspendia', 'delegate@suspendia.mock.test', [], null],
]) {
  const jar = new CookieJar();
  const login = await request(jar, '/auth/login?return_to=%2Fme%2F');
  assert.equal(login.status, 302);assert(jar.cookies.has('__Host-ituob_flow'));
  const page = await request(jar, login.headers.location);
  assert.equal(page.status, 200);assert(page.text.includes('Email address'));assert(page.text.includes('Test accounts'));
  const action = page.text.match(/<form method="post" action="([^"]+)"/)[1].replaceAll('&amp;', '&');
  const choose = await request(jar, action, { method: 'POST', body: new URLSearchParams({ email }).toString() });
  assert.equal(choose.status, 302);
  const callback = await request(jar, choose.headers.location);
  assert.equal(callback.status, 302);assert.equal(callback.headers.location, '/me/');
  assert(jar.cookies.has('__Host-ituob_session'));assert(!jar.cookies.has('__Host-ituob_flow'));
  const identity = JSON.parse((await request(jar, '/api/whoami')).text);
  assert.equal(identity.authenticated, true);assert.equal(identity.userId, `mock-${persona}`);
  assert.deepEqual(identity.roles, roles);assert.equal(identity.memberStateId, memberStateId);
  if (persona === 'member-suspendia') assert.equal((await request(jar, '/api/me/submissions', { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await request(jar, '/auth/logout')).status, 405);
  assert.equal((await request(jar, '/auth/logout', { method: 'POST', originHeader: 'https://elsewhere.example' })).status, 403);
  assert.equal((await request(jar, '/auth/logout', { method: 'POST' })).status, 303);
  assert(!jar.cookies.has('__Host-ituob_session'));
  assert.equal(JSON.parse((await request(jar, '/api/whoami')).text).authenticated, false);
  console.log(`${persona}: HTTPS email sign-in, identity, Secure cookies, CSRF rejection and POST sign-out PASS${persona === 'member-suspendia' ? '; suspended submission 403' : ''}`);
}
