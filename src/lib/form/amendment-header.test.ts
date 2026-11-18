import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { blankState } from './model';
import { amendmentHeader, positionPrefill, prefillPosition } from './amendment-header';
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
    expect(amendmentHeader(index, 'X121_DNIC')).toEqual({ kind: 'annexed', annexedTo: 1150, positionOn: '2024-05-31' });
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
