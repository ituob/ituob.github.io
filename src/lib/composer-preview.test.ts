import { describe, expect, it } from 'vitest';
import { composerPreviewLinks } from './composer-preview';

describe('composer preview links', () => {
  it('builds current and issue snapshot links for staged and published editions', () => {
    expect(composerPreviewLinks('e118-iin', 1234, 'staged')).toEqual({
      current: '/registers/e118-iin/',
      atIssue: '/registers/e118-iin/at/1234/',
    });
    expect(composerPreviewLinks('dp', 9, 'published')).toEqual({
      current: '/registers/dp/',
      atIssue: '/registers/dp/at/9/',
    });
  });

  it.each([
    '../admin',
    'two/segments',
    'https://example.test',
    'e118-iin?next=/admin',
    'UPPERCASE',
    '',
  ])('rejects unsafe slug %j', (slug) => {
    expect(composerPreviewLinks(slug, 1234, 'staged')).toBeNull();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '1234'])
    ('rejects invalid issue number %j', (issue) => {
      expect(composerPreviewLinks('e118-iin', issue, 'published')).toBeNull();
    });

  it.each(['open', 'composing', 'unknown', null, undefined])
    ('keeps links hidden before projection for %j editions', (status) => {
      expect(composerPreviewLinks('e118-iin', 1234, status)).toBeNull();
    });
});
