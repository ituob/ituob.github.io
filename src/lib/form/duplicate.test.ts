import { describe, expect, it } from 'vitest';
import { duplicateDraft, duplicateHref } from './duplicate';
import { payloadErrors } from '../admin-client';

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
});
