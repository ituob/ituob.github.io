import { env } from 'cloudflare:workers';
import { beforeEach, afterEach, expect, it } from 'vitest';
import worker from '../worker/index.ts';
import { registerStateFromSnapshot, validateWithWarnings, type ActionType } from '../worker/lib/validation.ts';
import { FakePatchPublisher, setPublisher } from '../worker/lib/publisher.ts';
import { db, provisionItu, seedFixtures } from './helpers.ts';

const entry = (key: string) => ({ country_or_area: { en: 'Aland' }, company_name: 'Acme', issue_id_number: key });
const payload = (keys: string[], type = 'ADD') => ({ type, data: { _class: 'E118Amendment', entries: keys.map(entry) } });
const snapshot = () => Response.json({ active_entries: [entry('active')], lapsed_keys: ['lapsed'] });
type Fetch = (r: Request) => Promise<Response>;
let calls: string[];
let assets: { fetch: Fetch } | undefined;
beforeEach(async () => {
  await seedFixtures(); await provisionItu('itu-editor', ['itu-editor']); await provisionItu('itu-admin', ['itu-admin']);
  calls = []; assets = { fetch: async r => { calls.push(r.url); return snapshot(); } };
  setPublisher(new FakePatchPublisher());
});
afterEach(() => setPublisher(null));
async function request(method: string, path: string, body?: unknown, admin = false) {
  const res = await worker.fetch(new Request(`http://localhost${path}`, {
    method, headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin',
      [admin ? 'X-Stub-Access' : 'X-Stub-Session']: admin ? 'itu-admin@example.test' : 'itu-editor' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), { ...env, ASSETS: assets } as any);
  return { status: res.status, json: await res.json() as any };
}
const create = (keys: string[], action = 'ADD') => request('POST', '/api/me/submissions', {
  register_id: 'E118_IIN', slug: 'e118-iin', action_type: action, payload: payload(keys, action),
});
it('trusted snapshots reject existing ADD and missing changes; stale snapshots warn', () => {
  const state = registerStateFromSnapshot('E118_IIN', { active_entries: [entry('active')], lapsed_keys: ['lapsed'] });
  for (const action_type of ['ADD', 'REP', 'MOD', 'SUP', 'DEL'] as ActionType[]) {
    const key = action_type === 'ADD' ? 'active' : 'missing';
    const ctx = { register_id: 'E118_IIN', action_type, payload: payload([key], action_type), register_state: state };
    expect(validateWithWarnings(ctx).errors).toEqual([expect.objectContaining({ code: 'mismatch', path: 'data.entries[0].issue_id_number' })]);
    expect(validateWithWarnings({ ...ctx, register_state: { ...state, stale: true } })).toMatchObject({ errors: [], warnings: [expect.objectContaining({ code: 'mismatch' })] });
  }
});
it('ASSETS URL and active/lapsed/missing route matrix retain advisory conflicts', async () => {
  for (const action of ['ADD', 'REP', 'MOD', 'SUP', 'DEL', 'LIR']) for (const key of ['active', 'lapsed', 'missing']) {
    const r = await create([key], action);
    expect(r.status).toBe(201);
    const conflict = action === 'ADD' ? key === 'active' : action !== 'LIR' && key === 'missing';
    expect(r.json.warnings).toHaveLength(conflict ? 2 : 1);
    expect(r.json.warnings.filter((w: any) => w.code === 'mismatch')).toHaveLength(conflict ? 1 : 0);
  }
  expect(calls).toHaveLength(18);
  expect(new Set(calls)).toEqual(new Set(['https://www.ituob.org/data/snapshots/e118-iin/current.json']));
});
it('missing/bad ASSETS never blocks valid content and never masks duplicate errors', async () => {
  const cases: (Fetch | undefined)[] = [undefined,
    async () => new Response('secret path', { status: 404 }),
    async () => { throw new Error('secret path'); },
    async () => new Response('{broken'),
    async () => Response.json({}),
    async () => Response.json({ active_entries: [null], lapsed_keys: [] }),
    async () => Response.json({ active_entries: [], lapsed_keys: [1] }),
  ];
  for (const fetch of cases) {
    assets = fetch ? { fetch } : undefined;
    const valid = await create(['new']);
    expect(valid.status).toBe(201);
    expect(valid.json.warnings).toEqual([expect.objectContaining({ path: 'register_state', code: 'unknown' })]);
    expect(JSON.stringify(valid.json)).not.toContain('secret path');
    const bad = await create(['new', 'new']);
    expect(bad.status).toBe(422);
    expect(bad.json.errors).toEqual([expect.objectContaining({ path: 'data.entries[1].issue_id_number' })]);
    expect(bad.json.warnings).toHaveLength(1);
  }
});
it('duplicates block every action without snapshot and leave no durable writes', async () => {
  assets = undefined;
  for (const action of ['ADD', 'REP', 'MOD', 'SUP', 'DEL', 'LIR', 'SEED']) {
    const r = await create(['new', 'new'], action);
    expect(r.status).toBe(422);
    expect(r.json.errors.some((e: any) => e.message.includes('more than once'))).toBe(true);
  }
  for (const table of ['submissions', 'submission_revisions', 'submission_prs']) {
    expect(await db().prepare(`SELECT count(*) AS n FROM ${table}`).first('n')).toBe(0);
  }
});
it('draft edit, submit, revise warnings stay visible and revisions preserve their own results', async () => {
  const made = await create(['new']); const id = made.json.submission.id;
  const edit = await request('PUT', `/api/me/submissions/${id}`, { payload: payload(['active']) });
  expect(edit.status).toBe(200); expect(edit.json.warnings).toHaveLength(2);
  const submitted = await request('POST', `/api/me/submissions/${id}/submit`);
  expect(submitted.status).toBe(200); expect(submitted.json.warnings).toHaveLength(2);
  await request('POST', `/api/admin/submissions/${id}/start-review`, {}, true);
  await request('POST', `/api/admin/submissions/${id}/request-changes`, { reason: 'revise' }, true);
  const revised = await request('POST', `/api/me/submissions/${id}/revise`, { payload: payload(['newer']) });
  expect(revised.status).toBe(200); expect(revised.json.warnings).toHaveLength(1);
  const rows = (await db().prepare('SELECT validation FROM submission_revisions WHERE submission_id=? ORDER BY rev').bind(id).all()).results;
  expect(rows.map((r: any) => JSON.parse(r.validation).warnings.length)).toEqual([1, 2, 1]);
});
it.each([false, true])('approval exposes and records newly discovered warnings (publisher fails: %s)', async (publisherFails) => {
  const publisher = new FakePatchPublisher();
  publisher.failNext = publisherFails ? 1 : 0;
  setPublisher(publisher);
  const made = await create(['new']); const id = made.json.submission.id;
  await request('POST', `/api/me/submissions/${id}/submit`);
  await request('POST', `/api/admin/submissions/${id}/start-review`, {}, true);
  assets = { fetch: async () => Response.json({ active_entries: [entry('new')], lapsed_keys: [] }) };
  const approved = await request('POST', `/api/admin/submissions/${id}/approve`, { target_edition: 1351 }, true);
  expect(approved.status).toBe(publisherFails ? 202 : 200);
  expect(approved.json.submission.state).toBe(publisherFails ? 'pr_pending' : 'pr_open');
  expect(approved.json.submission).not.toHaveProperty('warnings');
  const validation = await db().prepare('SELECT validation FROM submission_revisions WHERE submission_id=? AND rev=1').bind(id).first<string>('validation');
  expect(JSON.parse(validation!).warnings.some((w: any) => w.code === 'mismatch')).toBe(false);
  expect(approved.json.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'mismatch', message: expect.stringContaining('already exists') })]));
  const audits = (await db().prepare("SELECT detail FROM audit_log WHERE submission_id=? AND action='submission.state'").bind(id).all()).results;
  const approval = audits.map((row: any) => JSON.parse(row.detail)).find((detail: any) => detail.to === 'pr_pending');
  expect(approval.warnings).toEqual(approved.json.warnings);
  expect(approval.rev).toBe(1);
});
