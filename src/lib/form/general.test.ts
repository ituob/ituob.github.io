import { readFileSync } from 'node:fs';
import { compileScript, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import { describe, expect, it } from 'vitest';
import * as general from './general';
import * as model from './model';
import * as yamlIo from './yaml-io';
import * as invalidInput from './invalid-input';
import { description } from './description';
import * as client from '../admin-client';
import { validateClass } from '../schema.validators.generated';

function proseControls(value: unknown) {
  const file = 'src/components/admin/SchemaNode.vue';
  const source = compileScript(parse(readFileSync(file, 'utf8')).descriptor, { id: 'prose-controls' }).content;
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: any = {};
  const modules: Record<string, unknown> = { vue: Vue, './TranslationAssist.vue': {}, '../../lib/form/description': { description },
    '../../lib/admin-client': client, '../../lib/form/model': model, '../../lib/form/yaml-io': yamlIo, '../../lib/form/general': general, '../../lib/form/invalid-input': invalidInput };
  new Function('require', 'exports', js)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected component import: ${name}`);
    return modules[name];
  }, exports);
  const changes: unknown[] = [];
  const props = { node: { kind: 'leaf', type: 'HashOrText', value }, prose: true, opaqueReadonly: true };
  const controls = exports.default.setup(props, { expose() {}, emit(name: string, value: unknown) { if(name === 'change') changes.push(value); } });
  return { controls, changes };
}

describe('general prose authoring controls', () => {
  it.each(general.GENERAL_TYPES)('starts a valid %s draft with the canonical scalar type', type => {
    const node = general.newGeneralState(type);
    expect(model.toInstance(node)).toEqual({ type });
    expect(validateClass(general.generalBinding(type).className, model.toInstance(node))).toEqual([]);
  });
  it('authors scalar telephone prose using generated nested models', () => {
    const value = { type: 'telephone_service_2', contents: [{ country_name: { en: 'Example' }, communications: [{ contents: 'New notice' }] }] };
    expect(validateClass('GeneralTelephoneService', value)).toEqual([]);
    expect(model.toInstance(model.toFormState('GeneralTelephoneService', value).state)).toEqual(value);
  });
  it('authors all six language texts while preserving rich text and unknown stored language fields', () => {
    const legacy = { en: { type: 'doc', content: [{ type: 'paragraph', content: [{type:'text',text:'Original'}] }] }, de: 'Unchanged' };
    const view = proseControls(legacy);
    view.controls.languageInput('fr', { target: { value: 'Avis révisé' } });
    expect(view.changes).toEqual([{ kind: 'leaf', type: 'HashOrText', value: { ...legacy, fr: 'Avis révisé' } }]);
    expect(() => view.controls.languageInput('en', { target: { value: 'Do not replace document' } })).toThrow(/read-only/);
    expect(legacy).not.toHaveProperty('fr');
    let prose: unknown = '';
    for (const language of general.PROSE_LANGUAGES) prose = general.setProseLanguage(prose, language, `${language} notice`);
    expect(Object.keys(prose as object)).toEqual(general.PROSE_LANGUAGES);
    expect(validateClass('GeneralCustom', { type: 'custom', contents: prose })).toEqual([]);
  });
  it('seeds prose with a scalar and rejects invalid nested structured data', () => {
    const contents = description.classes.GeneralTelephoneCommunication!.attributes.find(a => a.name === 'contents')!;
    expect(client.initialValue(contents)).toBe('');
    expect(validateClass('GeneralSancs', { type: 'sanc', contents: 'Notice', items: [{ country: 'Example', sanc: '7-001', arbitrary: true }] })).not.toEqual([]);
  });
  it('keeps a scalar plain text edit as text instead of parsing JSON', () => {
    const view = proseControls('Initial');
    view.controls.input({ target: { value: '{this is prose, not JSON}' } });
    expect(view.changes).toEqual([{ kind: 'leaf', type: 'HashOrText', value: '{this is prose, not JSON}' }]);
  });
});
