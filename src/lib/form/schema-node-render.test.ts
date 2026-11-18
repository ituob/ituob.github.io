import { readFileSync } from 'node:fs';
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import * as renderer from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import * as description from './description';
import * as general from './general';
import * as invalid from './invalid-input';
import * as model from './model';
import * as yamlIo from './yaml-io';
import * as adminClient from '../admin-client';

// Compile and server-render the real SchemaNode.vue (TranslationAssist replaced by a marker element).
function render(props: Record<string, unknown>): string {
  const filename = 'src/components/admin/SchemaNode.vue';
  const { descriptor } = parse(readFileSync(filename, 'utf8'));
  const Assist = { props: ['source', 'from', 'to'], render() { return Vue.h('i', { class: 'assist' }); } };
  const modules: Record<string, unknown> = {
    '../../styles/admin-forms.css': {}, vue: Vue, 'vue/server-renderer': renderer,
    './TranslationAssist.vue': { default: Assist },
    '../../lib/form/description': description, '../../lib/admin-client': adminClient, '../../lib/form/model': model,
    '../../lib/form/general': general, '../../lib/form/yaml-io': yamlIo, '../../lib/form/invalid-input': invalid,
  };
  const evaluate = (source: string) => {
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const result = { exports: {} as any };
    new Function('require', 'module', 'exports', js)((name: string) => {
      if (!(name in modules)) throw new Error(`Unexpected import ${name}`);
      return modules[name];
    }, result, result.exports);
    return result.exports;
  };
  const script = compileScript(descriptor, { id: 'schema-node-test' });
  const component = evaluate(script.content).default;
  const template = compileTemplate({ source: descriptor.template!.content, filename, id: 'schema-node-test', ssr: true, compilerOptions: { bindingMetadata: script.bindings } });
  expect(template.errors).toEqual([]);
  const ssrRender = evaluate(template.code).ssrRender;
  const root = { props: component.props, emits: component.emits, setup: component.setup, ssrRender };
  return renderer.renderToString(Vue.createSSRApp(root, props)) as unknown as string;
}
const count = (html: string, needle: string) => html.split(needle).length - 1;
const prose = (value: unknown) => ({ kind: 'leaf', type: 'HashOrText', value });

describe('SchemaNode language prose', () => {
  it('shows the read-only note only for a language holding rich text', async () => {
    const html = await render({ node: prose({ en: 'Hello', fr: 'Bonjour', ar: { rich: true } }), path: 'data.text', prose: true, translation: true });
    expect(count(html, '<textarea')).toBe(5);
    expect(count(html, 'Stored rich text is preserved read-only.')).toBe(1);
    expect(count(html, 'class="assist"')).toBe(4);
  });
  it('shows no read-only note beside editable languages when translation is off', async () => {
    const html = await render({ node: prose({ en: 'Hello', fr: 'Bonjour' }), path: 'data.text', prose: true });
    expect(count(html, '<textarea')).toBe(6);
    expect(html).not.toContain('Stored rich text');
    expect(html).not.toContain('class="assist"');
  });
});
