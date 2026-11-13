import { afterEach, describe, expect, it, vi } from 'vitest';
import { actionPayload, actionTypes, amendmentClasses, api, ApiError, initialValue, payloadErrors, revisionErrors } from '../admin-client';
import { description } from './description';
import { blankState, setField, toFormState, toInstance } from './model';

afterEach(() => vi.unstubAllGlobals());
describe('schema action UI contract', () => {
  it('derives class, enum, nested-class and collection controls from the generated ontology', () => {
    expect(amendmentClasses).toContain('E118Amendment');
    expect(amendmentClasses).not.toContain('E118Entry');
    expect(actionTypes).toContain('MOD'); expect(actionTypes).not.toContain('SEED');
    const entries = description.classes.E118Amendment!.attributes.find(a => a.wire === 'entries')!;
    expect(initialValue(entries)).toEqual([]);
    expect(initialValue({ ...entries, collection: false })).toEqual(toInstance(blankState(entries.type)));
    expect(initialValue({ name: 'type', wire: 'type', type: 'ActionType', kind: 'enum', required: false, collection: false })).toBe('ADD');
  });
  it('authors one action, preserving untouched envelope and legacy entry fields', () => {
    const stored = { _class: 'E118Amendment', entries: [{ country_or_area: { en: 'France' }, company_name: { en: 'Example' }, legacy: 'unchanged' }], notes: ['original'] };
    const state = setField(toFormState('E118Amendment', stored).state, 'notes', ['revised']);
    const result = actionPayload('MOD', state, { type: 'ADD', recommendation: 'E.118', reason: { en: 'Correction' } });
    expect(result).toEqual({ type: 'MOD', recommendation: 'E.118', reason: { en: 'Correction' }, data: { ...stored, notes: ['revised'] } });
    expect(result).not.toHaveProperty('active_entries');
    expect(result).not.toHaveProperty('identifier');
  });
  it('reports generated nested field errors and preserves the source value', () => {
    const node = toFormState('E118Amendment', { _class: 'E118Amendment', entries: [{ company_name: 17 }] }).state;
    const payload = actionPayload('ADD', node);
    expect(payloadErrors(payload).some(e => e.path.startsWith('data.entries[0].company_name'))).toBe(true);
    expect((payload.data as { entries: unknown[] }).entries[0]).toEqual({ company_name: 17 });
  });
  it('authors textual amendments through the generated text field', () => {
    const state = setField(blankState('TextAmendment'), 'text', 'Numbering plan update\nSecond paragraph');
    const payload = actionPayload('ADD', state);
    expect(payload.data).toEqual({ _class: 'TextAmendment', text: 'Numbering plan update\nSecond paragraph' });
    expect(payloadErrors(payload)).toEqual([]);
  });
  it('reads saved validation stages, including errors from incomplete drafts', () => {
    const issue = { path: 'data.entries', code: 'required', message: 'Add an entry' };
    expect(revisionErrors(JSON.stringify({ stage1: [issue], stage2: [], validator_version: 'v1' }))).toEqual([issue]);
  });
});
describe('same-origin submission API client', () => {
  it('sends credentialed JSON and returns only confirmed server success', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ok: true, submission: { id: 'saved' } })); vi.stubGlobal('fetch', fetcher);
    expect(await api('/api/me/submissions', 'POST', { payload: {} })).toEqual({ ok: true, submission: { id: 'saved' } });
    expect(fetcher).toHaveBeenCalledWith('/api/me/submissions', expect.objectContaining({ credentials: 'same-origin', method: 'POST', body: '{"payload":{}}' }));
  });
  it('retains field errors on 422 and explains denied access', async () => {
    const issue = { path: 'data.entries', code: 'required', message: 'Entry required' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'validation failed', errors: [issue] }, { status: 422 })));
    await expect(api('/api/me/submissions/x/submit', 'POST', {})).rejects.toMatchObject({ status: 422, errors: [issue] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'forbidden' }, { status: 403 })));
    await expect(api('/api/admin/submissions')).rejects.toThrow('Access denied');
  });
  it('does not treat an Access login HTML response as saved data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>Sign in</html>')));
    await expect(api('/api/admin/submissions')).rejects.toBeInstanceOf(ApiError);
  });
});
