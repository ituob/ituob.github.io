import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

// Source-derived E.212 messages supplement typed data with headings/field context.
test('E.212 context preserves its plain French heading and the explicit Country B relation', () => {
  const root = resolve('.');
  const fixture = mkdtempSync(join(tmpdir(), 'ituob-e212-context-'));
  try {
    for (const dir of ['components', 'lib']) cpSync(join(root, 'src', dir), join(fixture, 'src', dir), { recursive: true });
    mkdirSync(join(fixture, 'src/pages'), { recursive: true });
    mkdirSync(join(fixture, 'data/lists'), { recursive: true });
    const projections = {};
    for (const id of [997,1016]) {
      mkdirSync(join(fixture, `data-ob/ob-issues/${id}/e212-mnc`), { recursive: true });
      mkdirSync(join(fixture, `data/issues/${id}`), { recursive: true });
      projections[id] = readFileSync(join(root, `test/fixtures/e212-context/${id}.yaml`), 'utf8');
      writeFileSync(join(fixture, `data-ob/ob-issues/${id}/e212-mnc/001-REP.yaml`), projections[id]);
      cpSync(join(root, `test/fixtures/e212-context/${id}-source.yaml`), join(fixture, `data/issues/${id}/amendments.yaml`));
    }
    symlinkSync(join(root, 'node_modules'), join(fixture, 'node_modules'));
    cpSync(join(root, 'tsconfig.json'), join(fixture, 'tsconfig.json'));
    writeFileSync(join(fixture, 'package.json'), '{"type":"module"}');
    writeFileSync(join(fixture, 'astro.config.mjs'), `import { defineConfig } from 'astro/config'; export default defineConfig({output:'static', vite: {define: {'import.meta.env.OB_DATA_ROOT': ${JSON.stringify(JSON.stringify(join(fixture, 'data-ob')))}, 'import.meta.env.ITU_OB_DATA_ROOT': ${JSON.stringify(JSON.stringify(join(fixture, 'data')))}}}});`);
    writeFileSync(join(fixture, 'src/pages/index.astro'), `---
import StructuredAmendment from '~/components/StructuredAmendment.astro';
import PrintedRegisterContext from '~/components/PrintedRegisterContext.astro';
import { printedContext, e212CountryContext } from '~/lib/printed-context';
import { parse } from 'yaml';
const raw = ${JSON.stringify(projections)};
const entries = [997,1016].map(id => ({...parse(raw[id]), slug:'e212-mnc',seq:1,fileStem:'001-REP'}));
const original = JSON.stringify(entries);
const cell = text => ({type:'table_cell',content:[{type:'paragraph',content:[{type:'text',text}]}]});
const nonheader = {type:'table',content:[{type:'table_row',content:['Gabon','628 01','Nom de Réseau/Opérateur'].map(cell)}]};
if (printedContext([nonheader],{}).length) throw new Error('An ordinary first row is not a heading');
const countryTable = (code, operator) => ({type:'table',content:[
  {type:'table_row',content:['MCC/MNC','Name of operator(s) Countries A and B','Country B – where the MCC/MNC is to be used extra-territorially','MSIN range to be used in Country A','MSIN range to be used in Country B'].map(cell)},
  {type:'table_row',content:[code,operator,'Principality of Liechtenstein','Uncopied A range','Uncopied B range'].map(cell)},
]});
if (e212CountryContext([countryTable('999 99','Swisscom (Schweiz AG)')],entries).length) throw new Error('Code must match a typed row');
if (e212CountryContext([countryTable('228 01','Unrepresented operator')],entries).length) throw new Error('Operator must match the same typed row');
const representedCountry = {...entries[1].data.entries[0], country_b:'Principality of Liechtenstein'};
if (e212CountryContext([countryTable('228 01','Swisscom (Schweiz AG)')],representedCountry).length) throw new Error('An already represented country must not be copied');
---
{entries.map(amd => <section id={'typed-'+amd.ob_issue_no}><StructuredAmendment amendments={[amd]} /></section>)}
<div id="context-997"><PrintedRegisterContext slug="e212-mnc" issue={997} /></div>
<div id="context-1016"><PrintedRegisterContext slug="e212-mnc" issue={1016} /></div>
<p id="typed-counts">{entries.map(amd => amd.data.entries.length).join(',')}</p>
<p id="typed-unchanged">{JSON.stringify(entries) === original}</p>`);
    const result = spawnSync(process.execPath, [join(root, 'node_modules/astro/bin/astro.mjs'), 'build'], { cwd: fixture, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const html = readFileSync(join(fixture, 'dist/index.html'), 'utf8');
    const context997 = html.split('id="context-997"')[1].split('id="context-1016"')[0];
    assert.match(context997, /Nom de Réseau\/Opérateur/);
    assert.doesNotMatch(context997, /LIBERTIS|USAN GABON/);
    const context1016 = html.split('id="context-1016"')[1].split('id="typed-counts"')[0];
    assert.match(context1016, /Swisscom \(Schweiz AG\) \(228 01\) — Country B: Principality of Liechtenstein/);
    assert.doesNotMatch(context1016, /37XXXXXXXX|20XXXXXXXX/);
    const typed997 = html.split('id="typed-997"')[1].split('</section>')[0];
    for (const operator of ['LIBERTIS','MOOV','CELTEL','USAN GABON','RAG']) assert.match(typed997, new RegExp(operator));
    const typed1016 = html.split('id="typed-1016"')[1].split('</section>')[0];
    assert.equal((typed1016.match(/Swisscom \(Schweiz AG\)/g) ?? []).length, 1);
    assert.equal((typed1016.match(/37XXXXXXXX/g) ?? []).length, 1);
    assert.match(typed1016, /20XXXXXXXX-35XXXXXXXX/);
    assert.match(html, /id="typed-counts">5,1<\/p>/);
    assert.match(html, /id="typed-unchanged">true<\/p>/);
    for (const id of [997,1016]) assert.equal(readFileSync(join(fixture, `data-ob/ob-issues/${id}/e212-mnc/001-REP.yaml`), 'utf8'), projections[id]);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
