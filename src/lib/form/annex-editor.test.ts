import { readFileSync } from 'node:fs';
import { compileScript, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';
import * as Vue from 'vue';
import { describe, expect, it, vi } from 'vitest';
import * as annexes from './annexes';
import { ApiError } from '../admin-client';

function editor(existing: annexes.AnnexesWire, drafts: unknown[] = [], fail = false) {
  const source = compileScript(parse(readFileSync('src/components/admin/AnnexEditor.vue', 'utf8')).descriptor, { id: 'annex-editor' }).content;
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  let mounted!: () => Promise<void>;
  const api = vi.fn(async (path: string) => {
    if (path === '/annexes.json') {
      if (fail) throw new Error('Corpus unavailable');
      return { ok: true, annexes: { 1162: existing } };
    }
    return { drafts };
  });
  const modules: Record<string, unknown> = { vue: { ...Vue, onMounted: (fn: typeof mounted) => { mounted = fn; } },
    '../../lib/form/annexes': annexes, '../../lib/admin-client': { api, ApiError } };
  const exports: any = {};
  new Function('require', 'exports', js)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`);
    return modules[name];
  }, exports);
  const controls = exports.default.setup({}, { expose() {} });
  return { controls, mounted, api };
}

describe('existing annex editor data', () => {
  it('loads the complete pinned issue before editing and keeps unrelated positions, datasets and nulls', async () => {
    const existing = { ...parseYaml(readFileSync('test/fixtures/annexes/1162.yaml', 'utf8')), B: { position_on: '2017-10-01' }, C: null };
    const view = editor(existing);
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => [] })));
    await view.mounted();
    view.controls.issueNo.value = 1162;
    await view.controls.load(1162);
    expect(view.api).toHaveBeenCalledWith('/annexes.json');
    expect(view.controls.wire.value).toEqual(existing);
    expect(view.controls.wire.value.E212_MNC.position_on).toBe('2018-12-15T00:00:00.000Z');
    expect(view.controls.wire.value.E212_MNC.datasets).toBeDefined();
    view.controls.position('B', '2026-11-01');
    expect(view.controls.wire.value).toEqual({ ...existing, B: { position_on: '2026-11-01' } });
    expect(existing.B.position_on).toBe('2017-10-01');
    await view.controls.load(99999);
    expect(view.controls.wire.value).toEqual({});
    vi.unstubAllGlobals();
  });
  it('prefers a saved draft over the published corpus', async () => {
    const value = { Draft: null };
    const view = editor({ Old: null }, [{ id: 'draft', type: 'annexes', ob_issue_no: 1162, value }]);
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => [] })));
    await view.mounted();
    await view.controls.load(1162);
    expect(view.controls.wire.value).toEqual(value);
    expect(view.controls.dirty.value).toBe(false);
    vi.unstubAllGlobals();
  });
  it('keeps authoring disabled when the existing corpus cannot be loaded', async () => {
    const view = editor({}, [], true);
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => [] })));
    await view.mounted();
    expect(view.controls.error.value).toBe('Corpus unavailable');
    expect(view.controls.ready.value).toBe(false);
    vi.unstubAllGlobals();
  });
});
