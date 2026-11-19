import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

// OB 965's printed F.32 amendment has one populated Qatar row and two
// otherwise empty continuation rows. These labels are not registry records.
test('historical F.32 tbody preserves blank continuation labels without adding typed records', () => {
  const root = resolve('.');
  const fixture = mkdtempSync(join(tmpdir(), 'ituob-f32-continuations-'));
  try {
    for (const dir of ['components', 'lib']) cpSync(join(root, 'src', dir), join(fixture, 'src', dir), { recursive: true });
    mkdirSync(join(fixture, 'src/pages'), { recursive: true });
    mkdirSync(join(fixture, 'data-ob/ob-issues/965/f32-tdi'), { recursive: true });
    mkdirSync(join(fixture, 'data/issues/965'), { recursive: true });
    mkdirSync(join(fixture, 'data/lists'), { recursive: true });
    const projection = readFileSync(join(root, 'test/fixtures/f32-continuations/965.yaml'), 'utf8');
    writeFileSync(join(fixture, 'data-ob/ob-issues/965/f32-tdi/001-REP.yaml'), projection);
    cpSync(join(root, 'test/fixtures/f32-continuations/965-source.yaml'), join(fixture, 'data/issues/965/amendments.yaml'));
    symlinkSync(join(root, 'node_modules'), join(fixture, 'node_modules'));
    cpSync(join(root, 'tsconfig.json'), join(fixture, 'tsconfig.json'));
    writeFileSync(join(fixture, 'package.json'), '{"type":"module"}');
    writeFileSync(join(fixture, 'astro.config.mjs'), `import { defineConfig } from 'astro/config'; export default defineConfig({output:'static', vite: {define: {'import.meta.env.OB_DATA_ROOT': ${JSON.stringify(JSON.stringify(join(fixture, 'data-ob')))}, 'import.meta.env.ITU_OB_DATA_ROOT': ${JSON.stringify(JSON.stringify(join(fixture, 'data')))}}}});`);
    writeFileSync(join(fixture, 'src/pages/index.astro'), `---
import StructuredAmendment from '~/components/StructuredAmendment.astro';
import { blankContinuationLabels } from '~/lib/printed-context';
import { parse } from 'yaml';
const actual = {...parse(${JSON.stringify(projection)}), slug:'f32-tdi', seq:1, fileStem:'001-REP'};
const original = JSON.stringify(actual);
const control = {...actual, data:{entries:[{country_or_area:'Preserved control'}]}};
const p = text => ({type:'paragraph',content:[{type:'text',text}]});
const cell = text => ({type:'table_cell',content:[p(text)]});
const row = values => ({type:'table_row',content:values.map(cell)});
const illustrated = row(['QATAR','','','','']);
illustrated.content[1].content = [{type:'image',attrs:{src:'visible-image.png'}}];
const labels = blankContinuationLabels([{type:'table',content:[row(['QATAR','Unitel','DH--','All destinations','DHXX']),row(['QATAR',' ','\\u00a0','','']),row(['QATAR','Other','','','']),illustrated,row(['','','','','']),row(['QATAR','','','',''])]}]);
if (JSON.stringify(labels) !== '["QATAR"]') throw new Error('Only actual blank continuations may be recovered');
---
<StructuredAmendment amendments={[control,actual]} />
<p id="typed-count">{actual.data.entries.length}</p>
<p id="typed-unchanged">{JSON.stringify(actual) === original}</p>`);
    const result = spawnSync(process.execPath, [join(root, 'node_modules/astro/bin/astro.mjs'), 'build'], { cwd: fixture, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const html = readFileSync(join(fixture, 'dist/index.html'), 'utf8');
    const bodies = [...html.matchAll(/<tbody>(.*?)<\/tbody>/gs)].map(match => match[1]);
    assert.equal(bodies.length, 2);
    assert.doesNotMatch(bodies[0], /QATAR/);
    const rows = [...bodies[1].matchAll(/<tr>(.*?)<\/tr>/gs)].map(match => match[1]);
    assert.equal(rows.length, 3);
    assert.equal((bodies[1].match(/QATAR/g) ?? []).length, 3);
    assert.equal((bodies[1].match(/Unitel/g) ?? []).length, 1);
    assert.equal((bodies[1].match(/DHXX/g) ?? []).length, 1);
    assert.deepEqual(rows.slice(1), ['<td>QATAR</td><td></td><td></td><td></td><td></td>', '<td>QATAR</td><td></td><td></td><td></td><td></td>']);
    assert.match(html, /id="typed-count">1<\/p>/);
    assert.match(html, /id="typed-unchanged">true<\/p>/);
    assert.equal(readFileSync(join(fixture, 'data-ob/ob-issues/965/f32-tdi/001-REP.yaml'), 'utf8'), projection);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
