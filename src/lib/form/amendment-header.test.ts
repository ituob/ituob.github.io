import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { blankState, setField, type FormNode } from './model';
import { YamlTimestamp } from './yaml-io';
import { amendmentHeader, applyPrefill, positionPrefill, prefillPosition, zurichPositionDay, registerPrefillDay, prefillDay, freshPrefill, NO_PREFILL, sourceLines } from './amendment-header';
import type { AnnexIndexEntry } from './annexes';

const index: AnnexIndexEntry[] = [
  { issue: 1100, publication_id: 'Q708_SANC', position_on: '2020-01-01T00:00:00.000Z' },
  { issue: 1200, publication_id: 'Q708_SANC', position_on: null },
  { issue: 1150, publication_id: 'X121_DNIC', position_on: '2024-05-31T22:00:00.000Z' },
  { issue: 1300, publication_id: 'NOPOS', position_on: null },
];

describe('amendment header', () => {
  it('names the latest annex issue and the position carried forward', () => {
    expect(amendmentHeader(index, 'Q708_SANC')).toEqual({ kind: 'annexed', annexedTo: 1200, positionOn: '2020-01-01' });
    expect(amendmentHeader(index, 'X121_DNIC')).toEqual({ kind: 'annexed', annexedTo: 1150, positionOn: '2024-06-01' });
  });
  it('reports never annexed for an unknown publication or one with no known position', () => {
    expect(amendmentHeader(index, 'MISSING')).toEqual({ kind: 'never' });
    expect(amendmentHeader(index, 'NOPOS')).toEqual({ kind: 'never' });
    expect(amendmentHeader([], 'Q708_SANC')).toEqual({ kind: 'never' });
  });
  it('prefills position_on only when annexed', () => {
    expect(positionPrefill(amendmentHeader(index, 'Q708_SANC'))).toBe('2020-01-01');
    expect(positionPrefill({ kind: 'never' })).toBe('');
  });
});

describe('zurichPositionDay', () => {
  it.each([
    ['2023-12-31T23:00:00.000Z', '2024-01-01'],
    ['2024-06-30T22:00:00.000Z', '2024-07-01'],
    ['2020-01-01T00:00:00.000Z', '2020-01-01'],
    ['2024-05-31T12:00:00Z', '2024-05-31'],
    ['2024-03-30T23:00:00.000Z', '2024-03-31'],
    ['2024-03-31T22:00:00.000Z', '2024-04-01'],
    ['2023-12-31', '2023-12-31'],
  ])('%s is the Zurich day %s', (stored, day) => expect(zurichPositionDay(stored)).toBe(day));
  it('is empty for nothing or an invalid value', () => {
    expect(zurichPositionDay(null)).toBe('');
    expect(zurichPositionDay(undefined)).toBe('');
    expect(zurichPositionDay('2023-02-30')).toBe('');
  });
  it('shows the Zurich day in the header', () => {
    const rows: AnnexIndexEntry[] = [{ issue: 5, publication_id: 'P', position_on: '2023-12-31T23:00:00.000Z' }];
    expect(amendmentHeader(rows, 'P')).toEqual({ kind: 'annexed', annexedTo: 5, positionOn: '2024-01-01' });
  });
});

describe('position_on prefill across registers', () => {
  const text = (n: any) => { const v = n.fields.find((f: any) => f.attr.name === 'position_on').node?.value; return v === undefined || v === null ? '' : JSON.parse(JSON.stringify(v)); };
  it('replaces its own earlier prefill when the register changes', () => {
    const a = applyPrefill(blankState('Q708SANCAmendment'), '2020-01-01', '');
    expect(text(a.node)).toBe('2020-01-01');
    const b = applyPrefill(a.node, '2021-02-02', a.prefilled);
    expect(text(b.node)).toBe('2021-02-02');
    expect(b.prefilled).toBe('2021-02-02');
  });
  it('clears its own prefill when the new register was never annexed', () => {
    const a = applyPrefill(blankState('Q708SANCAmendment'), '2020-01-01', '');
    const b = applyPrefill(a.node, '', a.prefilled);
    expect(text(b.node)).toBe('');
    expect(b.prefilled).toBe('');
  });
  it('never overwrites a value the author typed', () => {
    const a = applyPrefill(blankState('Q708SANCAmendment'), '2020-01-01', '');
    const typed = setField(a.node as any, 'position_on', new YamlTimestamp('2019-09-09'));
    const b = applyPrefill(typed, '2021-02-02', a.prefilled);
    expect(b.node).toBe(typed);
    expect(text(b.node)).toBe('2019-09-09');
    expect(b.prefilled).toBe('');
    expect(applyPrefill(b.node, '2022-03-03', b.prefilled).node).toBe(typed);
  });
  it('fills a fresh form (a changed amendment class) with the kept annexed day', () => {
    const c = applyPrefill(blankState('Q708SANCAmendment'), '2020-01-01', '');
    expect(text(c.node)).toBe('2020-01-01');
  });
});

describe('position_on prefill', () => {
  const value = (n: any) => n.fields.find((f: any) => f.attr.name === 'position_on').node?.value;
  it('fills an empty position_on, keeps an authored one, ignores an empty day', () => {
    const blank = blankState('Q708SANCAmendment');
    expect(value(blank) ?? '').toBe('');
    const filled = prefillPosition(blank, '2020-01-01') as any;
    expect(JSON.parse(JSON.stringify({ v: value(filled) })).v).toBe('2020-01-01');
    expect(value(prefillPosition(filled, '2021-02-02'))).toBe(value(filled));
    expect(prefillPosition(blank, '')).toBe(blank);
  });
});

describe('translation mount', () => {
  it('mounts the assist on the general-message editor page and editor', () => {
    expect(readFileSync('src/pages/admin/general.astro', 'utf8')).toMatch(/<GeneralMessageEditor translation /);
    expect(readFileSync('src/components/admin/GeneralMessageEditor.vue', 'utf8')).toMatch(/<SchemaNode[^>]*:translation="translation"/);
    expect(readFileSync('src/components/admin/SchemaNode.vue', 'utf8')).toMatch(/<TranslationAssist[^>]*v-if="translation[^"]*language !== 'en'/s);
  });
});

describe('prefill across load and new (A-N2)', () => {
  const posOf = (n: FormNode) => { const f = n.kind === 'object' ? n.fields.find(x => x.attr.name === 'position_on') : undefined; const v = f?.node && f.node.kind === 'leaf' ? f.node.value : undefined; return v === undefined ? '' : String(v instanceof YamlTimestamp ? v.text : v); };
  const blank = () => blankState('Q708SANCAmendment');
  it('does not carry the previous register day into New after a load', () => {
    let r = freshPrefill(NO_PREFILL, blank());
    r = prefillDay(r.state, r.node, '2020-01-01');
    expect(posOf(r.node)).toBe('2020-01-01');
    const afterLoad = NO_PREFILL; // load() resets the state
    expect(posOf(freshPrefill(afterLoad, blank()).node)).toBe('');
    expect(posOf(freshPrefill(r.state, blank()).node)).toBe('2020-01-01');
  });
  it('clearing the register empties the prefill', () => {
    expect(registerPrefillDay(null)).toBe('');
    let r = prefillDay(NO_PREFILL, blank(), '2020-01-01');
    r = prefillDay(r.state, r.node, registerPrefillDay(null));
    expect(posOf(r.node)).toBe('');
    expect(posOf(freshPrefill(r.state, blank()).node)).toBe('');
  });
});

describe('amendment header source lines (legacy AmendmentMeta, amendment.tsx:93-103)', () => {
  it('prints the recommendation with title and the SP resource, like the legacy header', () => {
    expect(sourceLines({ recommendation: { body: 'ITU-T', code: 'E.129', version: '2013-01', title: 'Presentation of national numbers' }, url: 'http://www.itu.int/itu-t/inr/nnp/index.html' }))
      .toEqual({ recommendation: 'Per ITU-T Rec. E.129 (2013-01) Presentation of national numbers', url: 'http://www.itu.int/itu-t/inr/nnp/index.html' });
  });
  it('falls back to body and code when the recommendation has no catalog title', () => {
    expect(sourceLines({ recommendation: { body: 'ITU-T', code: 'F.170' } }).recommendation).toBe('Per ITU-T F.170');
  });
  it('omits what the publication does not have: no recommendation, empty url', () => {
    expect(sourceLines({ recommendation: null, url: '' })).toEqual({ recommendation: null, url: null });
    expect(sourceLines(undefined)).toEqual({ recommendation: null, url: null });
  });
});
