import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

test('register tables and recommendation cards preserve printed headings, notes and resources', () => {
  const root = resolve('.');
  const fixture = mkdtempSync(join(tmpdir(), 'ituob-register-render-'));
  try {
    for (const dir of ['components', 'lib']) cpSync(join(root, 'src', dir), join(fixture, 'src', dir), { recursive: true });
    const put = (path, value) => { mkdirSync(join(fixture, path, '..'), { recursive: true }); writeFileSync(join(fixture, path), value); };
    put('package.json', '{"type":"module"}');
    cpSync(join(root, 'tsconfig.json'), join(fixture, 'tsconfig.json'));
    symlinkSync(join(root, 'node_modules'), join(fixture, 'node_modules'));
    put('astro.config.mjs', `import {defineConfig} from 'astro/config'; export default defineConfig({vite:{cacheDir:${JSON.stringify(join(fixture,'.vite'))},define:{'import.meta.env.OB_DATA_ROOT':${JSON.stringify(JSON.stringify(join(fixture,'data-ob')))},'import.meta.env.ITU_OB_DATA_ROOT':${JSON.stringify(JSON.stringify(join(fixture,'data')))}}}});`);
    put('data-ob/catalogs/registers.yaml', JSON.stringify({ registers: [{ slug: 'e212-mnc', register_id: 'E212_MNC', url: 'https://example.test/mnc' }, { slug: 'e212-icc', register_id: 'E212_ICC' }] }));
    put('data-ob/ob-issues/969/meta.yaml', 'id: 969\npublication_date: 2010-12-01\n');
    for (const [id, publication, date] of [[967, 'E212_MNC', '2010-11-01'], [968, 'E212_ICC', '2010-11-15']]) {
      put(`data-ob/ob-issues/${id}/meta.yaml`, `id: ${id}\npublication_date: ${date}\n`);
      put(`data-ob/ob-issues/${id}/annexes.yaml`, `${publication}:\n  position_on: ${id === 967 ? "2010-10-31" : date}\n`);
    }
    const amendment = { type: 'ADD', identifier: { code: 'P 29' }, data: { entries: [{ country: 'Sudan', networks: 'Example Network <unsafe>' }] } };
    put('data-ob/ob-issues/969/e212-mnc/001-ADD.yaml', JSON.stringify(amendment));
    const note = 'Corrigendum: This announcement cancels and replaces that published in Operational Bulletin No. 967, page 5.';
    put('data/issues/969/amendments.yaml', JSON.stringify({ messages: [{ target: { publication: 'E212_MNC' }, contents: { en: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: note }] }] } } }] }));
    put('data-ob/ob-issues/1000/meta.yaml', 'id: 1000\npublication_date: 2012-03-15\n');
    put('data-ob/ob-issues/1000/t35-na/001-ADD.yaml', JSON.stringify({ type: 'ADD', identifier: { code: 'P 7' }, data: { entries: [{country:'Norway',manufactures_htv:true}] } }));
    put('data/issues/1000/amendments.yaml', JSON.stringify({ messages: [{ target: { publication: 'T35_NA' }, contents: { en: { type: 'doc', content: ['P 7 ADD Norway', 'Name of Administration:'].map(text => ({type:'paragraph',content:[{type:'text',text}]})) } } }] }));
    put('data-ob/ob-issues/975/meta.yaml', 'id: 975\npublication_date: 2011-03-01\n');
    put('data-ob/ob-issues/975/e164-acn/003-LIR.yaml', JSON.stringify({ type: 'LIR', identifier: { code: '8' }, data: { entries: [{country_or_area:{en:'Georgia'},country_code:'995',mobile_telephone_numbers:{en:'514, 551, 555, 557, 558, 568, 571, 574, 577-579, 591-593, 595-599, 770, 790'}}] } }));
    put('data/issues/975/amendments.yaml', JSON.stringify({ messages: [{ target: { publication: 'E164_ACN' }, contents: { en: { type: 'doc', content: ['P 9 Georgie LIR *', 'Mobile telephone numbers, first digits after country code'].map(text => ({type:'paragraph',content:[{type:'text',text}]})) } } }] }));
    put('src/pages/index.astro', `---
import RegisterTable from '~/components/RegisterTable.astro';
import StructuredAmendment from '~/components/StructuredAmendment.astro';
import RecommendationTimeline from '~/components/RecommendationTimeline.astro';
import RegisterHistory from '~/components/RegisterHistory.astro';
import PrintedRegisterContext from '~/components/PrintedRegisterContext.astro';
const entries = [{country_code:'216',mobile_telephone_numbers:'7xxx, 8xxx, 9xxx, 9xxxx'}, {network_roa:'Unitel',network_code:'DH- -',telegraph_office_name:'All destinations',office_code:'DHXX'}, {networks:'Example Network <unsafe>',manufactures_htv:true,last_updated:'28.II.2012',terminal_type:'H-Series',email:'test@example.test'}, {manufactures_htv:false,generic_boolean:true}];
const state = {active_entries:entries,entry_count:4,lapsed_keys:['retired'],lapsed_count:1,deleted_count:2,at_ob_issue:969};
const block = {id:969,date:'2010-12-01',positionOn:'2010-11-15',positionOnIssue:968,hasApprovals:false,generalMessages:[],registers:[{slug:'e212-mnc',title:'MNC',changes:[]},{slug:'e212-icc',title:'ICC',changes:[]}]};
---
<section id="action-caption"><PrintedRegisterContext slug="t35-na" issue={1000} /></section>
<section id="current-table"><RegisterTable state={state} keyField="country_code" showLapsed /></section>
<section id="amendment-table"><StructuredAmendment amendments={[{type:'ADD',identifier:{code:'216'},data:{entries}}]} /></section>
<RecommendationTimeline years={[2010]} yearGroups={new Map([[2010,[block]]])} lang="en" />
<RegisterHistory slug="e212-mnc" keyField="code" seedIssue={969} history={[]} />
<div id="acn-history"><RegisterHistory slug="e164-acn" keyField="country_code" seedIssue={975} history={[]} /></div>`);
    const build = spawnSync(process.execPath, [join(root, 'node_modules/astro/bin/astro.mjs'), 'build'], { cwd: fixture, encoding: 'utf8', env: { ...process.env, OB_DATA_ROOT: join(fixture, 'data-ob'), ITU_OB_DATA_ROOT: join(fixture, 'data') } });
    assert.equal(build.status, 0, build.stdout + build.stderr);
    const html = readFileSync(join(fixture, 'dist/index.html'), 'utf8');
    const tableText = html.match(/<section id="current-table">(.*?)<\/section>/s)[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    for (const label of ['E.164 Country Code', 'Mobile telephone numbers, first digits after country code', 'Name of Operator/Network', 'First 2 letters = Telegram Network Code', 'Third and fourth letters = Office Code', 'National manufacturers of H-, T- or V-Series compliant equipment?', 'Assignment authority:', 'Information updated:', 'E-mail:']) assert.ok(tableText.includes(label), label);
    const caption = html.match(/<section id="action-caption">(.*?)<\/section>/s)[1];
    assert.match(caption, /P 7 ADD Norway/);
    assert.doesNotMatch(caption, /Name of Administration:/, 'action context does not duplicate form labels');
    const acn = html.split('<div id="acn-history">')[1];
    assert.match(acn, /P 9 Georgie LIR \*/);
    assert.equal(acn.match(/<td>Georgia<\/td>/g)?.length, 1, 'typed country appears once');
    assert.equal(acn.match(/<td>995<\/td>/g)?.length, 1, 'country code preserved');
    assert.equal(acn.match(/514, 551, 555, 557, 558, 568, 571, 574, 577-579, 591-593, 595-599, 770, 790/g)?.length, 1, 'all number patterns preserved once');
    assert.equal(acn.match(/Mobile telephone numbers, first digits after country code/g)?.length, 1, 'caption context does not duplicate the form heading');
    const cards = [...html.matchAll(/<li class="panel p-4">(.*?)<\/li>/gs)].map(match => match[1]);
    assert.match(cards.find(card => card.includes('to MNC')), /href="\/issues\/967\/"/);
    assert.match(cards.find(card => card.includes('to MNC')), /1\.XI\.2010/);
    assert.doesNotMatch(cards.find(card => card.includes('to MNC')), /href="\/issues\/968\/"/);
    assert.match(cards.find(card => card.includes('to ICC')), /href="\/issues\/968\/"/);
    for (const id of ['current-table', 'amendment-table']) {
      const table = html.match(new RegExp(`<section id="${id}">(.*?)<\\/section>`, 's'))[1];
      assert.match(table, /<td>YES<\/td>/);
      assert.match(table, /<td>NO<\/td>/);
      assert.match(table, /<td>true<\/td>/, 'other boolean fields keep their generic formatting');
    }
    assert.equal(text.split(note).length - 1, 2, 'both recommendation and register history print the source note');
    assert.match(html, /href="https:\/\/example.test\/mnc"[^>]*>Authoritative resource/);
    for (const value of ['7xxx, 8xxx, 9xxx, 9xxxx', 'Unitel', 'DHXX', '28.II.2012', 'retired — lapsed', '4 active', '2 deleted']) assert.ok(text.includes(value), value);
    assert.match(html, /Example Network &lt;unsafe&gt;/);
    assert.doesNotMatch(html, /Example Network <unsafe>/);
  } finally { rmSync(fixture, {recursive:true,force:true}); }
});
