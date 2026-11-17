import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const report = JSON.parse(readFileSync(new URL('../docs/migration/old-url-map.json', import.meta.url), 'utf8'));
const page = url => report.pages.find(p => p.old_url === url);

test('every old HTML artifact is accounted for exactly once', () => {
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', report.inputs.legacy_sha], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(f => f.endsWith('.html'));
  assert.deepEqual(report.pages.map(p => p.old_file).sort(), files.sort());
  assert.equal(new Set(report.pages.map(p => p.old_url)).size, 648);
  assert.deepEqual(report.summary.compatibility.failures, []);
});

test('all public routes have concrete targets and only underscore copies remain unmapped', () => {
  for (const row of report.pages) {
    if (row.old_url.startsWith('/_app_help/')) {
      assert.equal(row.new_route, null);
      assert.equal(row.redirect_present, false);
    } else assert.ok(row.new_route && !row.new_route.includes('['), row.old_url);
  }
  assert.equal(report.pages.filter(p => p.old_url.startsWith('/docs/') && p.status === 'same_path').length, 11);
  assert.equal(page('/issues/1173-ru/').new_route, '/issues/1173/ru/');
  assert.equal(page('/issues/1173-zh/').new_route, '/issues/1173/zh/');
  assert.equal(page('/issues/1195-fr/').new_route, '/issues/1195/fr/');
});

test('all 299 scoped archives preserve their scope, with no overview fallbacks', () => {
  assert.equal(report.pages.filter(p => p.archive_disposition === 'exact_scope').length, 299);
  assert.equal(report.summary.compatibility.overview, 0);
  assert.equal(report.summary.compatibility.redirected, 624);
  assert.equal(page('/messages/complement-to-itu-t-r E.164/2010/').new_route, '/recommendations/E.164/years/2010/');
  assert.equal(page('/messages/complement-to-itu-t-r E.164/').new_route, '/recommendations/E.164/');
});
