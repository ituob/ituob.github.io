import { readFileSync } from 'node:fs';
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import * as renderer from 'vue/server-renderer';
import * as client from '../admin-client';
import * as model from './model';
import * as yamlIo from './yaml-io';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Exercise the real handlers and rendered controls without a browser dependency.
async function workspace(admin = true) {
  const filename = new URL('../../components/admin/SubmissionWorkspace.vue', import.meta.url);
  const { descriptor } = parse(readFileSync(filename, 'utf8'));
  const modules: Record<string, unknown> = {
    vue: Vue, 'vue/server-renderer': renderer, '../../lib/admin-client': client,
    '../../lib/form/model': model, '../../lib/form/yaml-io': yamlIo,
    './SchemaNode.vue': {},
  };
  function evaluate(source: string) {
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const result = { exports: {} as any };
    new Function('require', 'module', 'exports', js)((name: string) => {
      if (!(name in modules)) throw new Error(`Unexpected component import: ${name}`);
      return modules[name];
    }, result, result.exports);
    return result.exports;
  }
  const component = evaluate(compileScript(descriptor, { id: 'bulk-review-test' }).content).default;
  const template = compileTemplate({ source: descriptor.template!.content, filename: filename.pathname, id: 'bulk-review-test', ssr: true });
  expect(template.errors).toEqual([]);
  component.ssrRender = evaluate(template.code).ssrRender;
  const original = component.setup;
  let state: any;
  component.setup = (props: unknown, context: unknown) => {
    state = original(props, context);
    return { ...state };
  };
  // setup is run once in this wrapper, while renders reuse its reactive state.
  const app = Vue.createSSRApp(component, { admin });
  await renderer.renderToString(app);
  return { state, html: () => renderer.renderToString(Vue.createSSRApp({
    props: ['admin'],
    setup: () => ({ ...state }),
    ssrRender: component.ssrRender,
  }, { admin })) };
}
const row = (id: string, state = 'submitted') => ({ id, state, register_id: 'E118_IIN', slug: 'e118-iin', action_type: 'ADD', current_rev: 1 });
const response = (body: Record<string, unknown>, status = 200) => Response.json({ ok: status < 400, ...body }, { status });
afterEach(() => vi.unstubAllGlobals());

describe('bulk start review', () => {
  it('processes only selected current submitted IDs once, retains mixed outcomes, and refreshes', async () => {
    const view = await workspace();
    view.state.rows.value = [row('a'), row('b'), row('stale'), row('unselected')];
    view.state.reviewIds.value = ['a', 'a', 'b', 'stale', 'missing'];
    const calls: string[] = [];
    let lists = 0;
    const fetcher = vi.fn(async (path: string, options: RequestInit) => {
      calls.push(`${options.method} ${path}`);
      if (options.method === 'GET') return response({ submissions: ++lists === 1
        ? [row('a'), row('b'), row('stale', 'rejected'), row('unselected')]
        : [row('a', 'in_review'), row('b'), row('stale', 'rejected'), row('unselected')] });
      if (path.includes('/a/')) return response({ submission: row('a', 'in_review') });
      return response({ error: 'Self-review forbidden' }, 409);
    });
    vi.stubGlobal('fetch', fetcher);
    await view.state.startSelectedReviews();
    expect(calls).toEqual(['GET /api/admin/submissions', 'POST /api/admin/submissions/a/start-review', 'POST /api/admin/submissions/b/start-review', 'GET /api/admin/submissions']);
    expect(view.state.reviewResults.value).toEqual([
      { id: 'a', success: true, message: 'Review started.' },
      { id: 'b', success: false, message: 'Self-review forbidden' },
    ]);
    expect(view.state.rows.value.find((item: any) => item.id === 'a').state).toBe('in_review');
    expect(view.state.reviewIds.value).toEqual(['b']);
    const html = await view.html();
    expect(html).toContain('a: Review started.');
    expect(html).toContain('b: Self-review forbidden');
    expect(html).not.toContain('Select a for review');
    expect(html).toContain('Select b for review');
    expect(fetcher.mock.calls.filter(([, options]) => options.method === 'POST').map(([, options]) => options.body)).toEqual(['{}', '{}']);
  });

  it('hides selection from members and refuses role/state/deselection bypasses', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const member = await workspace(false);
    member.state.rows.value = [row('a')]; member.state.reviewIds.value = ['a'];
    await member.state.startSelectedReviews();
    expect(await member.html()).not.toContain('Select a for review');
    expect(await member.html()).not.toContain('Start review for selected');
    const admin = await workspace();
    admin.state.rows.value = [row('a', 'approved')]; admin.state.reviewIds.value = ['a'];
    await admin.state.startSelectedReviews();
    expect(await admin.html()).not.toContain('Select a for review');
    admin.state.rows.value = [row('a')]; admin.state.reviewIds.value = [];
    await admin.state.startSelectedReviews();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('waits for each outcome, blocks repeat clicks, and preserves successes if refresh fails', async () => {
    const view = await workspace();
    view.state.rows.value = [row('a'), row('b')]; view.state.reviewIds.value = ['a', 'b'];
    let finish!: (value: Response) => void;
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ submissions: [row('a'), row('b')] }))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }))
      .mockResolvedValueOnce(response({ submission: row('b', 'in_review') }))
      .mockRejectedValueOnce(new Error('Refresh unavailable'));
    vi.stubGlobal('fetch', fetcher);
    const pending = view.state.startSelectedReviews();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await view.state.startSelectedReviews();
    expect(fetcher).toHaveBeenCalledTimes(2);
    finish(response({ submission: row('a', 'in_review') }));
    await pending;
    expect(view.state.rows.value.map((item: any) => item.state)).toEqual(['in_review', 'in_review']);
    expect(view.state.reviewResults.value.map((item: any) => item.success)).toEqual([true, true]);
    expect(view.state.error.value).toBe('Refresh unavailable');
    expect(view.state.busy.value).toBe(false);
    const html = await view.html();
    expect(html).toContain('a: Review started.');
    expect(html).toContain('b: Review started.');
    expect(html).toContain('Refresh unavailable');
    expect(html).not.toContain('Select a for review');
    expect(html).not.toContain('Select b for review');
  });

  it('sends no transitions when current eligibility cannot be refreshed', async () => {
    const view = await workspace();
    view.state.rows.value = [row('a')]; view.state.reviewIds.value = ['a'];
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('Eligibility unavailable'));
    vi.stubGlobal('fetch', fetcher);
    await view.state.startSelectedReviews();
    expect(fetcher.mock.calls.map(([path, options]) => `${options.method} ${path}`)).toEqual(['GET /api/admin/submissions']);
    expect(view.state.error.value).toBe('Eligibility unavailable');
    expect(view.state.rows.value[0].state).toBe('submitted');
    expect(view.state.reviewIds.value).toEqual(['a']);
    expect(view.state.reviewResults.value).toEqual([]);
    expect(view.state.busy.value).toBe(false);
  });

  it('preserves the existing single-proposal transition payload and detail refresh', async () => {
    const view = await workspace();
    view.state.selected.value = 'a';
    view.state.reason.value = 'Review note'; view.state.override.value = true;
    vi.stubGlobal('window', { location: { pathname: '/admin/submissions/' }, history: { replaceState: vi.fn() } });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ submission: row('a', 'in_review') }))
      .mockResolvedValueOnce(response({
        submission: row('a', 'in_review'),
        revisions: [{ rev: 1, payload_yaml: JSON.stringify({ data: { _class: 'TextAmendment', text: 'Notice' } }), validation: '{}', created_at: '2026-11-16' }],
        history: [], pr: null,
      }))
      .mockResolvedValueOnce(response({ submissions: [row('a', 'in_review')] }));
    vi.stubGlobal('fetch', fetcher);
    await view.state.transition('start-review');
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
      '/api/admin/submissions/a/start-review', '/api/admin/submissions/a', '/api/admin/submissions',
    ]);
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ reason: 'Review note', target_edition: null, override_self_review: true });
    expect(view.state.detail.value.submission.state).toBe('in_review');
    expect(view.state.notice.value).toContain('Workflow action recorded.');
    expect(view.state.reviewResults.value).toEqual([]);
  });

});
