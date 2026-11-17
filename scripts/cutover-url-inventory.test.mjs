import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const report = JSON.parse(readFileSync(new URL('../docs/migration/old-url-map.json', import.meta.url), 'utf8'));
const page = (url) => report.pages.find(p => p.old_url === url);

test('every HTML artifact is represented once, preserving spaces and years', () => {
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', report.inputs.legacy_sha], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(f => f.endsWith('.html'));
  assert.deepEqual(report.pages.map(p => p.old_file).sort(), files.sort());
  assert.equal(new Set(report.pages.map(p => p.old_url)).size, files.length);
  assert.ok(page('/messages/complement-to-itu-t-r E.164/2010/'));
});

test('old issue slugs require a redirect to a concretely generated route', () => {
  assert.equal(page('/issues/1000-en/').new_route, '/issues/1000/');
  assert.equal(page('/issues/1000-en/').status, 'redirect_required');
  assert.equal(page('/issues/1000-en/').redirect_present, false);
  assert.equal(page('/').status, 'same_path');
});

test('help pages remain gaps and archive overviews are not claimed as equivalent', () => {
  assert.equal(page('/docs/').status, 'no_new_page');
  assert.equal(page('/_app_help/').new_route, null);
  assert.equal(page('/messages/complement-to-itu-t-r E.164/2010/').status, 'replacement_requires_decision');
  assert.equal(page('/messages/complement-to-itu-t-r E.164/').status, 'redirect_required');
  for (const row of report.pages) {
    if (row.status === 'no_new_page') assert.equal(row.new_route, null);
    else assert.ok(row.new_route && !row.new_route.includes('['));
  }
});

test('the report pins data and route source evidence', () => {
  for (const key of ['source_sha', 'legacy_sha', 'data_sha', 'data_ob_sha']) assert.match(report.inputs[key], /^[a-f0-9]{40}$/);
  assert.ok(report.evaluated_generators.find(r => r.source === 'src/pages/issues/[id]/index.astro').count >= 310);
  const translatedCount = report.evaluated_generators.find(r => r.source === 'src/pages/issues/[id]/[lang].astro').count;
  assert.equal(translatedCount, 0);
  assert.equal(report.evaluated_generators.find(r => r.source === 'src/pages/recommendations/[code]/index.astro').count, 3684);
  for (const row of report.pages.filter(r => r.old_file.startsWith('messages/complement-to-itu-t-r '))) assert.notEqual(row.status, 'no_new_page');
  assert.equal(report.summary.old_pages, report.pages.length);
  assert.equal(Object.values(report.summary.pages).reduce((a, b) => a + b, 0), report.pages.length);
});
