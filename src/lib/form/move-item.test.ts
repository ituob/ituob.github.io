import { readFileSync } from 'node:fs';
import { compileScript, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import { describe, expect, it } from 'vitest';
import * as client from '../admin-client';
import { applyInvalid } from './invalid-input';
import * as general from './general';
import * as model from './model';
import * as yamlIo from './yaml-io';
import * as invalidInput from './invalid-input';
import { description } from './description';
import { moveItem, toFormState, toInstance, updateAt, type FormNode, type ListNode } from './model';

const root = (names: string[]) => toFormState('IssueMetadata', { id: 1, authors: names.map(name => ({ name })) }).state as FormNode;
const move = (r: FormNode, index: number, delta: -1 | 1) => updateAt(r, ['authors'], n => moveItem(n as ListNode, index, delta));
const names = (r: FormNode) => (toInstance(r) as { authors: { name: string }[] }).authors.map(a => a.name);

describe('reordering list items (C6)', () => {
  it('swaps neighbours and keeps the serialized order', () => {
    const r = root(['a', 'b', 'c']);
    expect(names(move(r, 2, -1))).toEqual(['a', 'c', 'b']);
    expect(names(move(r, 0, 1))).toEqual(['b', 'a', 'c']);
  });
  it('treats an edge move as a no-op without mutating the source', () => {
    const r = root(['a', 'b']);
    expect(names(move(r, 0, -1))).toEqual(['a', 'b']);
    expect(names(move(r, 1, 1))).toEqual(['a', 'b']);
    move(r, 0, 1);
    expect(names(r)).toEqual(['a', 'b']);
  });
});

describe('pending invalid input while reordering (SchemaNode list state)', () => {
  it('clears a path and its descendants but not a sibling sharing the prefix', () => {
    const errors: Record<string, string> = { 'a[1].x': 'bad', 'a[2]': 'bad', a: 'bad', ab: 'bad', 'b[0]': 'bad' };
    applyInvalid(errors, 'a', '');
    expect(errors).toEqual({ ab: 'bad', 'b[0]': 'bad' });
    applyInvalid(errors, 'c', 'new');
    expect(errors.c).toBe('new');
  });
  function listNode() {
    const source = compileScript(parse(readFileSync('src/components/admin/SchemaNode.vue', 'utf8')).descriptor, { id: 'list-state' }).content;
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const exports: any = {};
    const modules: Record<string, unknown> = { vue: Vue, './TranslationAssist.vue': {}, '../../lib/form/description': { description }, '../../lib/admin-client': client,
      '../../lib/form/model': model, '../../lib/form/yaml-io': yamlIo, '../../lib/form/general': general, '../../lib/form/invalid-input': invalidInput, '../../styles/admin-forms.css': {} };
    new Function('require', 'exports', js)((name: string) => { if (!(name in modules)) throw new Error(`Unexpected import: ${name}`); return modules[name]; }, exports);
    const emitted: [string, ...unknown[]][] = [];
    const node = root(['a', 'b', 'c']);
    const list = (node as any).fields.find((f: any) => f.attr.wire === 'authors').node;
    const controls = exports.default.setup({ node: list, path: 'authors' }, { expose() {}, emit: (...args: [string, ...unknown[]]) => emitted.push(args) });
    return { controls, list, emitted };
  }
  it('blocks reordering while any item holds invalid input, and allows it again once valid', () => {
    const { controls, emitted } = listNode();
    expect(Vue.unref(controls.hasPending)).toBe(false);
    controls.itemInvalid('authors[1].name', 'Enter valid JSON for this field.');
    expect(Vue.unref(controls.hasPending)).toBe(true);
    expect(emitted).toContainEqual(['invalid', 'authors[1].name', 'Enter valid JSON for this field.']);
    controls.itemInvalid('authors[1].name', '');
    expect(Vue.unref(controls.hasPending)).toBe(false);
  });
  it('removing an item discards pending input and rebuilds the items from the model', () => {
    const { controls, list, emitted } = listNode();
    controls.itemInvalid('authors[2].name', 'bad');
    const epoch = Vue.unref(controls.epoch);
    controls.removeAt(list, 0);
    expect(Vue.unref(controls.hasPending)).toBe(false);
    expect(Vue.unref(controls.epoch)).toBe(epoch + 1);
    expect(emitted.at(-1)).toEqual(['invalid', 'authors', '']);
    expect(names((emitted.at(-2)![1] as any) && updateAt(root(['a', 'b', 'c']), ['authors'], () => emitted.at(-2)![1] as ListNode))).toEqual(['b', 'c']);
  });
});
