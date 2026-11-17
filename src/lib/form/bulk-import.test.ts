import { describe, expect, it } from 'vitest';
import { payloadErrors } from '../admin-client';
import { entryKey, planImport } from './bulk-import';

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
});
