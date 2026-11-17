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
import { validateGeneralMessage } from '../../../worker/lib/general-messages';

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

describe('ontology-backed general fields (D7, D14, D15, D18)', () => {
  it('edits GeneralCustom.title as multilingual text through the generated model', () => {
    const title = description.classes.GeneralCustom!.attributes.find(a => a.name === 'title')!;
    expect(title.type).toBe('MultilingualString');
    const value = { type: 'custom', title: { en: 'Notice', fr: 'Avis' }, text: 'Body' };
    expect(validateClass('GeneralCustom', value)).toEqual([]);
    const edited = model.setField(model.toFormState('GeneralCustom', value).state, 'title', { en: 'Changed', fr: 'Avis' });
    expect(model.toInstance(edited)).toEqual({ ...value, title: { en: 'Changed', fr: 'Avis' } });
  });
  it('rejects a non-object custom title', () => {
    expect(validateClass('GeneralCustom', { type: 'custom', title: ['not', 'a', 'title'] })).not.toEqual([]);
  });
  it.each([
    ['GeneralMid', 'contents', { type: 'mid', contents: 'Plain prose' }],
    ['GeneralTelephoneCommunication', 'contents', { date: '2020-01-01', contents: 'Plain prose' }],
  ])('%s.%s accepts text and keeps stored rich objects', (className, attr, value) => {
    const a = description.classes[className]!.attributes.find(x => x.name === attr)!;
    expect(a.type).toBe('HashOrText');
    expect(validateClass(className, value)).toEqual([]);
    expect(model.toInstance(model.toFormState(className, value).state)).toEqual(value);
    const rich = { ...value, contents: { en: { type: 'doc', content: [] } } };
    expect(model.toInstance(model.toFormState(className, rich).state)).toEqual(rich);
  });
  it('dispatches sanc to GeneralSancs and edits its plain-text contents', () => {
    expect(general.generalBinding('sanc').className).toBe('GeneralSancs');
    const value = { type: 'sanc', contents: 'Notice', items: [{ country: 'Example', sanc: '7-001' }] };
    expect(validateClass('GeneralSancs', value)).toEqual([]);
    expect(model.toInstance(model.toFormState('GeneralSancs', value).state)).toEqual(value);
  });
});


describe('SANC rich document compatibility', () => {
  const legacy = yamlIo.parseYaml(readFileSync('test/fixtures/general-messages/sanc.yaml', 'utf8')) as Record<string, unknown>;
  it('validates the historical rich document without adding typed rows through form save', () => {
    expect(legacy).not.toHaveProperty('items');
    expect(validateGeneralMessage('sanc', legacy).value).toEqual(legacy);
    const saved = model.toInstance(model.toFormState('GeneralSancs', legacy).state);
    expect(saved).toEqual(legacy);
    expect(validateGeneralMessage('sanc', saved).value).toEqual(legacy);
  });
  it.each([
    { type: 'sanc' },
    { type: 'sanc', contents: 'Notice' },
    { type: 'sanc', contents: {} },
    { type: 'sanc', contents: { en: {} } },
    { type: 'sanc', contents: { en: { text: 'Not a document' } } },
    { type: 'sanc', contents: { en: { type: 'doc', content: [] } } },
    { type: 'sanc', contents: { en: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '  ' }] }] } } },
    { ...legacy, items: [] },
    { ...legacy, items: [{}] },
    { ...legacy, items: [{ country: 'Example' }] },
    { ...legacy, items: [{ country: ' ', sanc: '7-001' }] },
    { ...legacy, notes: 7 },
    { ...legacy, notes: 'x'.repeat(10_001) },
  ])('rejects thin rich contents or invalid typed fields (case %#)', value => {
    expect(() => validateGeneralMessage('sanc', value)).toThrow();
  });
  it('retains strict validation of valid typed rows and content limits', () => {
    const items = [{ country: 'Example', sanc: '7-001' }];
    expect(validateGeneralMessage('sanc', { type: 'sanc', items }).value).toEqual({ type: 'sanc', items });
    expect(validateGeneralMessage('sanc', { ...legacy, items }).value).toEqual({ ...legacy, items });
    const oversized = { type: 'sanc', contents: { en: { type: 'doc', content: [{ type: 'text', text: 'x'.repeat(200_001) }] } } };
    expect(() => validateGeneralMessage('sanc', oversized)).toThrow();
  });
});
