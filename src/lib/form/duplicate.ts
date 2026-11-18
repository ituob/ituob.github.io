import { entryKeyOf } from '../../../worker/lib/validation';
import { REGISTER_IDENTITIES } from '../register-rules.generated';

/** The editor URL that starts a new ADD from an existing register item. */
export function duplicateHref(slug: string, key: string): string {
  return `/admin/editor/?${new URLSearchParams({ register: slug, duplicate_of: key })}`;
}

export interface DuplicateDraft { register_id: string; amendmentClass: string; data: Record<string, unknown> }

/**
 * The ADD payload data for a copy of the active entry with `key`: the key fields are cleared
 * (the copy must get its own key) and the provenance-only `source_contents` is dropped.
 * Returns null when the register has no amendment class or the key is not an active entry.
 */
export function duplicateDraft(register_id: string, activeEntries: unknown[], key: string): DuplicateDraft | null {
  const rules = Object.hasOwn(REGISTER_IDENTITIES, register_id) ? REGISTER_IDENTITIES[register_id] : undefined;
  if (!rules?.amendmentClass) return null;
  const source = activeEntries.find((e): e is Record<string, unknown> => !!e && typeof e === 'object' && !Array.isArray(e) && entryKeyOf(e as Record<string, unknown>, rules) === key);
  if (!source) return null;
  const entry = structuredClone(source);
  delete entry.source_contents;
  const usedKeys = rules.keyFields.some(f => entry[f] !== undefined && entry[f] !== null && entry[f] !== '') ? rules.keyFields : rules.fallbackKeyFields.find(g => g.some(f => entry[f])) ?? rules.keyFields;
  for (const field of usedKeys) if (field in entry) entry[field] = typeof entry[field] === 'object' && entry[field] !== null ? {} : '';
  return { register_id, amendmentClass: rules.amendmentClass, data: { _class: rules.amendmentClass, entries: [entry] } };
}
