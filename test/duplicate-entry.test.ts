import { env } from 'cloudflare:workers';
import { beforeEach, afterEach, expect, it } from 'vitest';
import worker from '../worker/index.ts';
import { FakePatchPublisher, setPublisher } from '../worker/lib/publisher.ts';
import { db, provisionItu, seedFixtures } from './helpers.ts';

// D103-2: a new ADD may name the active register item it was duplicated from.
const entry = (key: string) => ({ country_or_area: { en: 'Aland' }, company_name: 'Acme', issue_id_number: key });
const payload = (key: string) => ({ type: 'ADD', data: { _class: 'E118Amendment', entries: [entry(key)] } });
type Fetch = (r: Request) => Promise<Response>;
let assets: { fetch: Fetch } | undefined;
beforeEach(async () => {
  await seedFixtures(); await provisionItu('itu-editor', ['itu-editor']);
  assets = { fetch: async () => Response.json({ active_entries: [entry('active')], lapsed_keys: ['lapsed'] }) };
  setPublisher(new FakePatchPublisher());
});
afterEach(() => setPublisher(null));
async function create(body: Record<string, unknown>) {
  const res = await worker.fetch(new Request('http://localhost/api/me/submissions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', 'X-Stub-Session': 'itu-editor' },
    body: JSON.stringify({ register_id: 'E118_IIN', slug: 'e118-iin', action_type: 'ADD', payload: payload('new-1'), ...body }),
  }), { ...env, ASSETS: assets } as any);
  return { status: res.status, json: await res.json() as any };
}
const stored = async (id: string) => (await db().prepare('SELECT duplicate_of FROM submissions WHERE id=?1').bind(id).first<{ duplicate_of: string | null }>())?.duplicate_of;
const audit = async (id: string) => JSON.parse((await db().prepare(`SELECT detail FROM audit_log WHERE submission_id=?1 AND action='submission.created'`).bind(id).first<{ detail: string }>())!.detail);

it('stores duplicate_of for an active source item and records it in the audit detail', async () => {
  const r = await create({ duplicate_of: 'active' });
  expect(r.status).toBe(201);
  expect(r.json.submission?.duplicate_of ?? r.json.duplicate_of).toBe('active');
  const id = r.json.submission?.id ?? r.json.id;
  expect(await stored(id)).toBe('active');
  expect((await audit(id)).duplicate_of).toBe('active');
});
it('leaves duplicate_of null when it is not given', async () => {
  const r = await create({});
  expect(r.status).toBe(201);
  expect(await stored(r.json.submission?.id ?? r.json.id)).toBeNull();
});
it('rejects a source that is lapsed or not in the register, and stores nothing', async () => {
  for (const key of ['lapsed', 'missing']) {
    const r = await create({ duplicate_of: key });
    expect(r.status).toBe(422);
    expect(r.json.errors).toEqual([expect.objectContaining({ path: 'duplicate_of', code: 'mismatch' })]);
  }
  expect((await db().prepare('SELECT COUNT(*) n FROM submissions').first<{ n: number }>())!.n).toBe(0);
});
it('rejects a malformed duplicate_of and one on a non-ADD action', async () => {
  for (const bad of ['', '  ', 7, { k: 1 }, 'x'.repeat(501)]) expect((await create({ duplicate_of: bad })).status).toBe(400);
  const rep = await create({ action_type: 'REP', payload: { ...payload('active'), type: 'REP' }, duplicate_of: 'active' });
  expect(rep.status).toBe(400);
});
it('refuses rather than guesses when the snapshot cannot verify the source', async () => {
  for (const fetch of [undefined, async () => new Response('x', { status: 404 }), async () => Response.json({})] as (Fetch | undefined)[]) {
    assets = fetch ? { fetch } : undefined;
    const r = await create({ duplicate_of: 'active' });
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(JSON.stringify(r.json)).not.toContain('secret');
  }
  expect((await db().prepare('SELECT COUNT(*) n FROM submissions').first<{ n: number }>())!.n).toBe(0);
});
