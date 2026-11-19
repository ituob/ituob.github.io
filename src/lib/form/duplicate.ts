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
  // Clear every key group (primary and fallbacks) so the copy has no identity until the user enters one.
  for (const field of [...rules.keyFields, ...rules.fallbackKeyFields.flat()]) if (field in entry) entry[field] = typeof entry[field] === 'object' && entry[field] !== null ? {} : '';
  return { register_id, amendmentClass: rules.amendmentClass, data: { _class: rules.amendmentClass, entries: [entry] } };
}

export interface DuplicateSource { register_id: string; slug: string; key: string }

/** The key to send as duplicate_of: only while the form is still an ADD on the register it was copied from. */
export function duplicateOfToSend(source: DuplicateSource | null, form: { register_id: string; slug: string; action: string }): string | undefined {
  return source && form.action === 'ADD' && form.register_id === source.register_id && form.slug === source.slug ? source.key : undefined;
}

/** Load the public snapshot (plain JSON, not the `{ok:true}` API envelope) and build the draft for `key`. */
export async function loadDuplicateDraft(fetcher: typeof fetch, register: { register_id: string; slug: string }, key: string): Promise<DuplicateDraft> {
  const response = await fetcher(`/data/snapshots/${encodeURIComponent(register.slug)}/current.json`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`The register snapshot could not be loaded (HTTP ${response.status}).`);
  const snapshot = await response.json() as { active_entries?: unknown };
  const draft = duplicateDraft(register.register_id, Array.isArray(snapshot.active_entries) ? snapshot.active_entries : [], key);
  if (!draft) throw new Error(`Entry "${key}" cannot be duplicated: it is not an active entry of this register.`);
  return draft;
}
