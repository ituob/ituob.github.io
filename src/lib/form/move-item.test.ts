import { describe, expect, it } from 'vitest';
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
