import { describe, expect, it } from 'vitest';
import { validateClass } from '../schema.validators.generated';
import { inheritedMetadata, previousEdition } from './edition-defaults';

const previous = {
  id: 1330, publication_date: '2026-01-15', cutoff_date: '2026-01-05', incomplete: true, issn: '1564-5320',
  languages: { en: true, fr: true }, authors: [{ name: 'Houlin Zhao', contacts: [{ type: 'email', data: 'a@itu.int' }] }],
} as never;

describe('new-edition defaults', () => {
  it('carries ISSN, languages and authors but never dates or the completeness flag', () => {
    const out = inheritedMetadata(1331, previous);
    expect(out).toEqual({ id: 1331, issn: '1564-5320', languages: { en: true, fr: true }, authors: (previous as { authors: unknown }).authors });
    expect(out).not.toHaveProperty('publication_date');
    expect(out).not.toHaveProperty('incomplete');
    expect(validateClass('IssueMetadata', out)).toEqual([]);
  });
  it('deep-copies so editing the new draft cannot alter the source edition', () => {
    const out = inheritedMetadata(1331, previous);
    (out.authors![0] as { name: string }).name = 'Changed';
    expect((previous as { authors: { name: string }[] }).authors[0]!.name).toBe('Houlin Zhao');
  });
  it('falls back to the id alone for a missing or malformed source', () => {
    for (const source of [null, undefined, 'x' as never, { languages: [] } as never]) expect(inheritedMetadata(5, source)).toEqual({ id: 5 });
  });
  it('inherits only from an earlier edition, not from the latest one when an older or the same number is opened', () => {
    expect(inheritedMetadata(1330, previous)).toEqual({ id: 1330 });   // same edition
    expect(inheritedMetadata(900, previous)).toEqual({ id: 900 });     // an older edition is not preceded by 1330
    expect(inheritedMetadata(1331, previous)).toHaveProperty('issn');  // the next one still inherits
    expect(inheritedMetadata(2000, previous)).toHaveProperty('authors');
    expect(previousEdition(900, previous)).toBeNull();
    expect(previousEdition(1331, previous)).toBe(previous);
  });
});
