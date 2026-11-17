import { describe, expect, it } from 'vitest';
import { payloadErrors } from '../admin-client';
import { REGISTER_IDENTITIES } from '../register-rules.generated';
import { entryKey, importableRegister, planImport } from './bulk-import';

const row = (code: string, extra: Record<string, unknown> = {}) => ({ country_or_area: { en: code }, company_name: `Co ${code}`, issue_id_number: `89 ${code}`, ...extra });
const current = [row('A'), row('B'), row('C')];

describe('bulk import emits a patch series, never state', () => {
  it('computes ADD, REP and SUP against the current state and counts unchanged rows', () => {
    const plan = planImport('E118_IIN', current, [row('A'), row('B', { company_name: 'Renamed' }), row('D')]);
    expect(plan).toMatchObject({ added: 1, replaced: 1, superseded: 1, unchanged: 1, blocked: null, errors: [] });
    const byType = Object.fromEntries(plan.actions.map(a => [a.type, a.data.entries]));
    expect(byType.ADD).toEqual([row('D')]);                      // ADD carries the complete new item
    expect(byType.REP).toEqual([row('B', { company_name: 'Renamed' })]);
    expect(byType.SUP).toEqual([{ issue_id_number: '89 C', country_or_area: { en: 'C' } }]); // key (+ country) only
    expect(plan.actions.every(a => a.data._class === 'E118Amendment')).toBe(true);
  });
  it('produces payloads the ontology validators accept', () => {
    const plan = planImport('E118_IIN', current, [row('A'), row('D')]);
    for (const action of plan.actions) expect(payloadErrors({ type: action.type, data: action.data })).toEqual([]);
  });
  it('splits a large change into reviewable chunks', () => {
    const many = Array.from({ length: 5 }, (_, i) => row(`N${i}`));
    const plan = planImport('E118_IIN', current, [...current, ...many], { chunkSize: 2 });
    expect(plan.actions.map(a => [a.type, a.data.entries.length])).toEqual([['ADD', 2], ['ADD', 2], ['ADD', 1]]);
  });
  it('is a no-op when the list equals the current state, regardless of key order', () => {
    const reordered = current.map(r => Object.fromEntries(Object.entries(r).reverse()));
    expect(planImport('E118_IIN', current, reordered)).toMatchObject({ actions: [], unchanged: 3, blocked: null });
  });
  it('rejects bad input before any action exists', () => {
    expect(planImport('E118_IIN', current, [row('A'), row('A')]).errors).toEqual([{ row: 1, message: 'Duplicate identity in the import' }]);
    expect(planImport('E118_IIN', current, [{ company_name: 'x' }]).errors[0]!.row).toBe(0);
    expect(planImport('E118_IIN', current, 'nope').errors[0]!.row).toBeNull();
    expect(planImport('NOPE', current, [row('A')]).errors).toHaveLength(1);
    expect(planImport('E118_IIN', current, [row('A'), 3]).actions).toEqual([]);
  });
  it('plans one unblocked SEED with every row for an empty register, never chunked', () => {
    const plan = planImport('E118_IIN', [], [row('A'), row('B'), row('C')], { chunkSize: 2 });
    expect(plan.actions.map(a => [a.type, a.data.entries.length])).toEqual([['SEED', 3]]);
    expect(plan.blocked).toBeNull();
    expect(payloadErrors({ type: 'SEED', data: plan.actions[0]!.data })).toEqual([]);
  });
  it('identity uses the first available field group and trims parts', () => {
    expect(entryKey('E118_IIN', { issue_id_number: ' 89 1 ' })).toBe('89 1');
    expect(entryKey('E118_IIN', {})).toBeNull();
  });
  it('keeps a no-break space as data, so a register round-trips through its own current state', () => {
    const nbsp = '\u00a0';
    const rows = [{ mcc_mnc_codes: '240 01', networks: 'A', country_or_area: { en: 'Sweden' } }, { mcc_mnc_codes: nbsp, networks: nbsp, country_or_area: { en: ` Sweden ADD` } }];
    expect(entryKey('E212_MNC', rows[1]!)).toBe(nbsp);
    expect(entryKey('E212_MNC', { mcc_mnc_codes: ' \t' })).toBeNull(); // ASCII whitespace is still padding
    expect(planImport('E212_MNC', rows, structuredClone(rows))).toMatchObject({ actions: [], errors: [], unchanged: 2 });
  });
  it('refuses to supersede a row the server could not accept, and says which and why', () => {
    const noCountry = { issue_id_number: '89 9', company_name: 'No country' };
    const plan = planImport('E118_IIN', [...current, noCountry], [row('A'), row('B'), row('C')]);
    expect(plan.actions).toEqual([]);
    expect(plan.errors).toEqual([{ row: null, message: expect.stringContaining('89 9') }]);
    expect(plan.errors[0]!.message).toMatch(/country_or_area/);
    expect(planImport('E118_IIN', current, [row('A'), row('B')]).errors).toEqual([]); // rows with a country still supersede
  });
  it('offers only registers the server accepts, and plans nothing for the others', () => {
    for (const [id, slug] of [['E164_NOTE_N', 'e164-note-n'], ['E164_NOTE_O', 'e164-note-o'], ['E164_NOTE_PQ', 'e164-note-pq'], ['E212_SHARED_MCC', 'e212-shared-mcc'], ['E118_IIN', 'wrong-slug'], ['NOPE', 'nope']] as const) {
      expect(importableRegister(id, slug), id).toBe(false);
      expect(planImport(id, [], [{ a: 1 }]).errors, id).toHaveLength(1);
    }
    expect(importableRegister('E118_IIN', 'e118-iin')).toBe(true);
    // The typed registers the server's catalog lacks are exactly these four; any other typed register is importable.
    const typed = Object.keys(REGISTER_IDENTITIES).filter(k => REGISTER_IDENTITIES[k]!.amendmentClass);
    expect(typed.filter(id => planImport(id, [], [{ x: 1 }]).errors[0]?.message.includes('not a catalog register')).sort())
      .toEqual(['E164_NOTE_N', 'E164_NOTE_O', 'E164_NOTE_PQ', 'E212_SHARED_MCC']);
  });

describe('the plan is checked by the server validator before it is offered', () => {
  const mnc = (code: string, country?: string) => ({ mcc_mnc_codes: code, networks: `Net ${code}`, ...(country ? { country_or_area: { en: country } } : {}) });
  it('rejects, per row, a row the server would refuse (E.212 row without a country), and plans no action', () => {
    const plan = planImport('E212_MNC', [], [mnc('412 01', 'Afghanistan'), mnc('276 01'), mnc('276 03')]);
    expect(plan.actions).toEqual([]);
    expect(plan.errors.map(e => e.row)).toEqual([1, 2]);
    expect(plan.errors[0]!.message).toContain('country_or_area is required');
  });
  it('does not carry the previous row\'s country forward: the neighbour above a continuation row is another country', () => {
    const plan = planImport('E212_MNC', [], [mnc('412 88', 'Afghanistan'), mnc('276 01'), mnc('276 02', 'Albania')]);
    expect(plan.errors.map(e => e.row)).toEqual([1]);
  });
  it('applies to ADD and REP as well as SEED', () => {
    const have = [mnc('412 01', 'Afghanistan')];
    expect(planImport('E212_MNC', have, [...have, mnc('276 01')]).errors.map(e => e.row)).toEqual([1]);
    expect(planImport('E212_MNC', have, [{ ...have[0]!, country_or_area: undefined }]).errors.map(e => e.row)).toEqual([0]);
  });
  it('reports a mistyped field once per row with the server message (T.35 manufactures_htv)', () => {
    const ok = { country: 'iso-3166:bw', administration_name: 'A', manufactures_htv: false, assignment_authority: [] };
    const plan = planImport('T35_NA', [], [ok, { ...ok, country: 'iso-3166:de', manufactures_htv: 'yes' }]);
    expect(plan.actions).toEqual([]);
    expect(plan.errors).toEqual([{ row: 1, message: expect.stringContaining('manufactures_htv must be a boolean') }]);
  });
  it('still plans a valid import, and every planned action passes the server validator', () => {
    const plan = planImport('E212_MNC', [], [mnc('412 01', 'Afghanistan'), mnc('276 02', 'Albania')]);
    expect(plan.errors).toEqual([]);
    expect(plan.actions.map(a => a.type)).toEqual(['SEED']);
  });
});
});
