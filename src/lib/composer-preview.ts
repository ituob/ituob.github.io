export interface ComposerPreviewLinks {
  current: string;
  atIssue: string;
}

const REGISTER_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Build same-origin preview links only after the edition has been projected. */
export function composerPreviewLinks(
  slug: unknown,
  issue: unknown,
  editionStatus: unknown,
): ComposerPreviewLinks | null {
  if (editionStatus !== 'staged' && editionStatus !== 'published') return null;
  if (typeof slug !== 'string' || !REGISTER_SLUG.test(slug)) return null;
  if (typeof issue !== 'number' || !Number.isSafeInteger(issue) || issue <= 0) return null;

  return {
    current: `/registers/${slug}/`,
    atIssue: `/registers/${slug}/at/${issue}/`,
  };
}
