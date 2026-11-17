import type { IssueMetadataWire } from '../schema.generated';

const clone = <T>(value: T): T => structuredClone(value);

/** The source only counts for an edition that comes after it: the page hands over the latest published edition,
 * which is not the predecessor of an earlier (or the same) edition number. The source must name itself with a
 * positive whole-number id below `no`; a missing, textual, fractional, zero, negative or structured id is not a
 * predecessor, so nothing is inherited from it. */
export function previousEdition(no: number, previous: IssueMetadataWire | null | undefined): IssueMetadataWire | null {
  if (!previous || typeof previous !== 'object') return null;
  const id: unknown = previous.id;
  return Number.isSafeInteger(id) && (id as number) > 0 && (id as number) < no ? previous : null;
}

/**
 * Starting metadata for a new edition (legacy `defaults/issue/meta.yaml`, map row B8).
 * The masthead identity (ISSN, languages, authors with contacts) carries over from the
 * latest published edition; the dates and any completeness flag never do. A missing or
 * unusable source yields only the edition id, which is what the form started from before.
 */
export function inheritedMetadata(no: number, previous: IssueMetadataWire | null | undefined): IssueMetadataWire {
  const out: IssueMetadataWire = { id: no };
  if (!previousEdition(no, previous)) return out;
  previous = previous!;
  if (typeof previous.issn === 'string' && previous.issn) out.issn = previous.issn;
  if (previous.languages && typeof previous.languages === 'object' && !Array.isArray(previous.languages)) out.languages = clone(previous.languages);
  if (Array.isArray(previous.authors) && previous.authors.length) out.authors = clone(previous.authors);
  return out;
}
