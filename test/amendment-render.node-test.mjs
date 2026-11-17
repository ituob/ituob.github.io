import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

// Source-derived projections and the pinned historical message exercise public HTML.
test('amendments retain late measurement remarks, contact labels, stations and technical form headings', () => {
  const root = resolve('.');
  const fixture = mkdtempSync(join(tmpdir(), 'ituob-amendment-render-'));
  try {
    for (const dir of ['components', 'lib']) cpSync(join(root, 'src', dir), join(fixture, 'src', dir), { recursive: true });
    mkdirSync(join(fixture, 'src/pages'), { recursive: true });
    for (const [id, slug] of [[991, 'list-viii'], [1087, 'list-viii'], [1129, 'm1400-icc'], [1168, 'list-viii']]) {
      mkdirSync(join(fixture, `data-ob/ob-issues/${id}/${slug}`), { recursive: true });
      cpSync(join(root, `test/fixtures/amendment-render/${id}.yaml`), join(fixture, `data-ob/ob-issues/${id}/${slug}/001-ADD.yaml`));
    }
    mkdirSync(join(fixture, 'data/issues/991'), { recursive: true });
    mkdirSync(join(fixture, 'data/lists'), { recursive: true });
    cpSync(join(root, 'test/fixtures/amendment-render/991-source.yaml'), join(fixture, 'data/issues/991/amendments.yaml'));
    symlinkSync(join(root, 'node_modules'), join(fixture, 'node_modules'));
    cpSync(join(root, 'tsconfig.json'), join(fixture, 'tsconfig.json'));
    writeFileSync(join(fixture, 'package.json'), '{"type":"module"}');
    writeFileSync(join(fixture, 'astro.config.mjs'), `import { defineConfig } from 'astro/config'; export default defineConfig({output:'static', vite: {define: {'import.meta.env.OB_DATA_ROOT': ${JSON.stringify(JSON.stringify(join(fixture, 'data-ob')))}, 'import.meta.env.ITU_OB_DATA_ROOT': ${JSON.stringify(JSON.stringify(join(fixture, 'data')))}}}});`);
    writeFileSync(join(fixture, 'src/pages/index.astro'), `---
import StructuredAmendment from '~/components/StructuredAmendment.astro';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
const amendments = [[991,'list-viii'], [1087,'list-viii'], [1129,'m1400-icc'], [1168,'list-viii']].map(([id,slug]) => ({ ...parse(readFileSync(process.cwd()+'/data-ob/ob-issues/'+id+'/'+slug+'/001-ADD.yaml','utf8')), slug, seq: 1, fileStem:'001-ADD' }));
amendments.find(amd => amd.ob_issue_no === '1087').data.entries[0].measurements.push(null);
---
{amendments.map(amd => <section id={'issue-'+amd.ob_issue_no}><StructuredAmendment amendments={[amd]} /></section>)}`);
    const result = spawnSync(process.execPath, [join(root, 'node_modules/astro/bin/astro.mjs'), 'build'], { cwd: fixture, encoding: 'utf8', env: { ...process.env, OB_DATA_ROOT: join(fixture, 'data-ob'), ITU_OB_DATA_ROOT: join(fixture, 'data') } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const html = readFileSync(join(fixture, 'dist/index.html'), 'utf8');
    const section = id => html.split(`id="issue-${id}"`)[1].split('</section>')[0];
    const monitoring = section(1087);
    assert.match(monitoring, /Two magnetic dipoles - multiturn frames with ferrite cores/);
    assert.match(monitoring, /11.93 m in height/);
    assert.match(monitoring, /54°47&#39;56&#39;&#39;N/);
    assert.match(monitoring, /office@srfc.ru/);
    const contacts = section(1129);
    assert.match(contacts, /Tel:\s*<\/span>\s*\+49 30 340 605 908/);
    assert.match(contacts, /Fax:\s*<\/span>\s*\+49 30 340 605 998/);
    assert.match(contacts, /E-mail:\s*<\/span>\s*portierung@42com.com/);
    assert.equal((section(1168).match(/Station: /g) ?? []).length, 9);
    assert.match(section(1168), /SMG Constanta \(IMS\)/);
    assert.match(section(1168), /stationid=519/);
    const technical = section(991);
    assert.equal((technical.match(/Maximum attainable accuracy in determining orbital positions/g) ?? []).length, 3);
    assert.equal((technical.match(/Information available for bandwidth measurements/g) ?? []).length, 3);
    assert.match(technical, /–210 dBW\/m 2 ± 1 dB/);
    assert.match(technical, /7 m Cassegrain antenna/);
    assert.equal((technical.match(/0\.1°/g) ?? []).length, 2, "decimal measurements remain in typed notes only");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
