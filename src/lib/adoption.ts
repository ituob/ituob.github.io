/**
 * Adoption matching (ituob.github.io#106). Pure and dependency-free: used by the
 * downloads page script and by tests. A PDF is "ITU-adopted" only when a live
 * adoption record names the same standard, edition, language AND sha256 as the
 * served file. Anything else, including a re-render with a new sha256, is a candidate.
 */
export interface AdoptionKey {
  standard: string;
  edition_year: number;
  language: string;
  sha256: string;
}

export function isAdopted(file: AdoptionKey, records: readonly AdoptionKey[]): boolean {
  return records.some(
    (r) =>
      r.standard === file.standard &&
      r.edition_year === file.edition_year &&
      r.language === file.language &&
      r.sha256 === file.sha256,
  );
}

/** An edition is official only when every language file is adopted (same rule as groupPublications). */
export function editionAdopted(files: readonly AdoptionKey[], records: readonly AdoptionKey[]): boolean {
  return files.length > 0 && files.every((f) => isAdopted(f, records));
}
