import { describe, expect, it } from 'vitest';
import { duplicateDraft, duplicateHref, duplicateOfToSend, loadDuplicateDraft } from './duplicate';
import { payloadErrors } from '../admin-client';
import { entryKeyOf } from '../../../worker/lib/validation';
import { REGISTER_IDENTITIES } from '../register-rules.generated';

const e164 = { country_code: '43', country_area_or_service: { en: 'Austria', fr: 'Autriche' }, source_contents: ['x'] };
describe('duplicate entry', () => {
  it('builds the editor link with register and key', () => {
    expect(duplicateHref('e164-cc', '43')).toBe('/admin/editor/?register=e164-cc&duplicate_of=43');
    expect(duplicateHref('e118-iin', 'a b&c')).toBe('/admin/editor/?register=e118-iin&duplicate_of=a+b%26c');
  });
  it('copies the active entry, clears its key and drops source_contents', () => {
    const d = duplicateDraft('E164_CC', [{ country_code: '1', country_area_or_service: { en: 'US' } }, e164], '43')!;
    expect(d.amendmentClass).toBe('E164CCAmendment');
    expect(d.data).toEqual({ _class: 'E164CCAmendment', entries: [{ country_code: '', country_area_or_service: { en: 'Austria', fr: 'Autriche' } }] });
    expect(e164.country_code).toBe('43');
    expect(e164.source_contents).toEqual(['x']);
  });
  it('returns null for an unknown key or register', () => {
    expect(duplicateDraft('E164_CC', [e164], '99')).toBeNull();
    expect(duplicateDraft('NOPE', [e164], '43')).toBeNull();
  });
  it('a prefilled draft is blocked until a key is entered, then validates', () => {
    const d = duplicateDraft('E164_CC', [e164], '43')!;
    const payload = (data: unknown) => ({ type: 'ADD', data });
    const entry = (d.data.entries as Record<string, unknown>[])[0]!;
    expect(payloadErrors(payload({ ...d.data, entries: [{ ...entry, country_code: '44' }] }))).toEqual([]);
  });
  it('clears the fallback key group too (E.164 cc_ic entry)', () => {
    const entry = { applicant: 'World Global Telecom', network: '+991 001', cc_ic: '15.I.2019', status: '15.I.2020', country_code: '15.I.2019' };
    const d = duplicateDraft('E164_CC', [entry], '15.I.2019')!;
    const copy = (d.data.entries as Record<string, unknown>[])[0]!;
    expect(copy.cc_ic).toBe('');
    expect(copy.country_code).toBe('');
    expect(copy.network).toBe('+991 001');
    expect(entryKeyOf(copy, REGISTER_IDENTITIES.E164_CC!)).toBeNull();
  });
  it('sends duplicate_of only for an ADD on the register it was copied from', () => {
    const src = { register_id: 'E164_CC', slug: 'e164-cc', key: '43' };
    expect(duplicateOfToSend(src, { register_id: 'E164_CC', slug: 'e164-cc', action: 'ADD' })).toBe('43');
    expect(duplicateOfToSend(src, { register_id: 'E164_CC', slug: 'e164-cc', action: 'REP' })).toBeUndefined();
    expect(duplicateOfToSend(src, { register_id: 'E118_IIN', slug: 'e118-iin', action: 'ADD' })).toBeUndefined();
    expect(duplicateOfToSend(null, { register_id: 'E164_CC', slug: 'e164-cc', action: 'ADD' })).toBeUndefined();
  });
  it('loads a real-shaped snapshot (no ok flag) through plain fetch', async () => {
    const snapshot = { slug: 'e164-cc', at_ob_issue: 1200, entry_count: 1, lapsed_count: 0, deleted_count: 0, error_count: 0, errors: [], active_entries: [e164], lapsed_keys: [], lapse_reasons: {}, deleted_keys: [], history: [], key_history: {} };
    const urls: string[] = [];
    const ok = (async (url: string) => { urls.push(url); return Response.json(snapshot); }) as unknown as typeof fetch;
    const d = await loadDuplicateDraft(ok, { register_id: 'E164_CC', slug: 'e164-cc' }, '43');
    expect(urls).toEqual(['/data/snapshots/e164-cc/current.json']);
    expect((d.data.entries as Record<string, unknown>[])[0]).toMatchObject({ country_code: '', country_area_or_service: { en: 'Austria' } });
    await expect(loadDuplicateDraft(ok, { register_id: 'E164_CC', slug: 'e164-cc' }, '99')).rejects.toThrow(/not an active entry/);
    const missing = (async () => new Response('no', { status: 404 })) as unknown as typeof fetch;
    await expect(loadDuplicateDraft(missing, { register_id: 'E164_CC', slug: 'e164-cc' }, '43')).rejects.toThrow(/HTTP 404/);
  });
});
