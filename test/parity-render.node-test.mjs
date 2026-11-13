import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

// Build real issue routes against a small, source-derived corpus. No corpus
// checkout, HTTP listener, or generated snapshots are required.
test('public HTML preserves annexes, incompleteness, communications and the printed T.35 label', () => {
  const root = resolve('.');
  const fixture = mkdtempSync(join(tmpdir(), 'ituob-parity-render-'));
  try {
    for (const dir of ['components', 'layouts', 'lib']) {
      cpSync(join(root, 'src', dir), join(fixture, 'src', dir), { recursive: true });
    }
    mkdirSync(join(fixture, 'src/pages/issues/[id]'), { recursive: true });
    cpSync(join(root, 'src/pages/issues/[id]/index.astro'), join(fixture, 'src/pages/issues/[id]/index.astro'));
    cpSync(join(root, 'test/fixtures/parity-render/issues'), join(fixture, 'data-ob/ob-issues'), { recursive: true });
    cpSync(join(root, 'test/fixtures/parity-render/lists'), join(fixture, 'data/lists'), { recursive: true });
    // An explicitly incomplete edition remains incomplete after adding content.
    mkdirSync(join(fixture, 'data-ob/ob-issues/669/general'), { recursive: true });
    writeFileSync(join(fixture, 'data-ob/ob-issues/669/general/running_annexes.yaml'), 'type: running_annexes\npayload: {}\n');
    mkdirSync(join(fixture, 'data-ob/ob-issues/1351/misc_communications'), { recursive: true });
    writeFileSync(join(fixture, 'data-ob/ob-issues/1351/meta.yaml'), 'id: 1351\npublication_date: 2026-12-01\ncutoff_date: 2026-11-15\n');
    writeFileSync(join(fixture, 'data-ob/ob-issues/1351/misc_communications/001.yaml'), 'type: misc_communications\nob_issue_no: "1351"\ncontents: "New authored bulletin notice. <script>alert(1)</script>"\n');
    writeFileSync(join(fixture, 'data-ob/secret.adoc'), 'SENSITIVE PROJECTION SECRET');
    writeFileSync(join(fixture, 'data-ob/ob-issues/1351/misc_communications/002.yaml'), 'type: misc_communications\nob_issue_no: "1351"\ncontents: "../../secret.adoc"\n');
    symlinkSync(join(root, 'node_modules'), join(fixture, 'node_modules'));
    cpSync(join(root, 'tsconfig.json'), join(fixture, 'tsconfig.json'));
    writeFileSync(join(fixture, 'package.json'), '{"type":"module"}');
    // Isolate issue/component HTML from the unrelated Vue site chrome.
    writeFileSync(join(fixture, 'src/layouts/Base.astro'), '<html><head><title>{Astro.props.title}</title></head><body><slot /></body></html>');
    writeFileSync(join(fixture, 'astro.config.mjs'), `import { defineConfig } from 'astro/config';
export default defineConfig({ output: 'static', trailingSlash: 'always', vite: { define: { 'import.meta.env.OB_DATA_ROOT': ${JSON.stringify(JSON.stringify(join(fixture, 'data-ob')))}, 'import.meta.env.ITU_OB_DATA_ROOT': ${JSON.stringify(JSON.stringify(join(fixture, 'data')))} } } });`);
    writeFileSync(join(fixture, 'src/pages/table.astro'), `---
import RegisterTable from '~/components/RegisterTable.astro';
const state = { active_entries: [{ country: 'iso-3166:de', manufactures_htv: true, last_updated: '2006-03-10' }], entry_count: 1, lapsed_keys: ['old'], lapsed_count: 1, deleted_count: 0, at_ob_issue: 1001 };
---
<RegisterTable state={state} keyField="country" showLapsed />`);
    const result = spawnSync(process.execPath, [join(root, 'node_modules/astro/bin/astro.mjs'), 'build'], { cwd: fixture, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const html = id => readFileSync(join(fixture, `dist/issues/${id}/index.html`), 'utf8');
    const authored = html(1351);
    assert.match(authored, /New authored bulletin notice\./);
    assert.doesNotMatch(authored, /SENSITIVE PROJECTION SECRET/);
    assert.match(authored, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(authored, /<script>alert\(1\)<\/script>/);
    const incomplete = html(669);
    assert.match(incomplete, /data below may not be complete yet/);
    assert.match(incomplete, /Annexes to this issue/);
    assert.match(incomplete, /Five-letter Code Groups/);
    assert.match(incomplete, /id="annexes"/);
    const annex = html(1125);
    assert.match(annex, /href="https:\/\/www\.itu\.int\/pub\/T-SP-E\.218-2011"/);
    assert.match(annex, /List of terrestrial trunk radio mobile country codes/);
    const table = readFileSync(join(fixture, 'dist/table/index.html'), 'utf8');
    assert.match(table, /National manufacturers of H-, T- or V-Series compliant equipment\?/);
    assert.doesNotMatch(table, /manufactures htv/);
    assert.match(table, /iso-3166:de/);
    assert.match(table, /2006-03-10/);
    assert.match(table, /old — lapsed/);
    for (const [id, signs] of [[1167, ['YU125VS']], [1168, ['YU73BFG']], [1170, ['YT74DP', 'YU10WCA']]]) {
      const rendered = html(id);
      for (const sign of signs) assert.match(rendered, new RegExp(`<strong>${sign}</strong>`));
      assert.match(rendered, /Serbia/);
      assert.match(rendered, /Communication of/);
      assert.match(rendered, /<sup>(th|rd)<\/sup>/);
      assert.doesNotMatch(rendered, /general\/misc_comms\.adoc/);
      assert.doesNotMatch(rendered, /data below may not be complete yet/);
      assert.doesNotMatch(rendered, /id="annexes"/);
      assert.match(rendered, new RegExp(`/issues/${id}/#general-1`));
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
