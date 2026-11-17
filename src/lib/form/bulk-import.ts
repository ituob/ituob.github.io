import { AMENDMENT_COUNTRY_FIELDS, REGISTER_IDENTITIES } from '../register-rules.generated';

/**
 * Bulk import of an external full list (map row W2, #101 "Authoring is actions, not files").
 * The list is never written anywhere as state. It is compared with the register's current replayed
 * state and turned into a patch series: ADD for new keys, REP for changed rows (the complete new row),
 * SUP for keys that disappeared (the key, plus the country field the validator requires).
 * An empty register is established by a single SEED (staff-only, enforced by the server).
 */
export interface PlannedAction {
  type: 'ADD' | 'REP' | 'SUP' | 'SEED';
  data: { _class: string; entries: Record<string, unknown>[] };
}
export interface ImportPlan {
  actions: PlannedAction[];
  added: number; replaced: number; superseded: number; unchanged: number;
  errors: { row: number | null; message: string }[];
  /** Reserved: a reason the series cannot be submitted, or null when every action can go through review. */
  blocked: string | null;
}
type Row = Record<string, unknown>;
const isRow = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v);

function part(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (!isRow(value)) return null;
  for (const language of ['fr', 'en', 'es', 'zh', 'ru', 'ar']) {
    const text = value[language];
    if (typeof text === 'string' && text.trim()) return text.trim();
  }
  return null;
}
/** Replay's identity: the first field group that yields any part; parts joined in field order. */
export function entryKey(registerId: string, row: Row): string | null {
  const rules = REGISTER_IDENTITIES[registerId];
  if (!rules) return null;
  for (const group of [rules.keyFields, ...rules.fallbackKeyFields]) {
    const parts = group.map(field => part(row[field]));
    if (parts.some(p => p !== null)) return parts.map(p => p ?? '').join('\u0001');
  }
  return null;
}
const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => isRow(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : x);
const chunks = <T>(items: T[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

export function planImport(registerId: string, current: Row[], imported: unknown, options: { chunkSize?: number } = {}): ImportPlan {
  const plan: ImportPlan = { actions: [], added: 0, replaced: 0, superseded: 0, unchanged: 0, errors: [], blocked: null };
  const rules = REGISTER_IDENTITIES[registerId];
  if (!rules?.amendmentClass) { plan.errors.push({ row: null, message: `${registerId} has no typed register class; use the text amendment form` }); return plan; }
  if (!Array.isArray(imported) || imported.length === 0) { plan.errors.push({ row: null, message: 'The import must be a non-empty list of rows' }); return plan; }
  const size = Math.max(1, options.chunkSize ?? 50), cls = rules.amendmentClass;
  const next = new Map<string, Row>(), seen = new Set<string>();
  imported.forEach((row, index) => {
    if (!isRow(row)) { plan.errors.push({ row: index, message: 'Row must be an object' }); return; }
    const key = entryKey(registerId, row);
    if (key === null) { plan.errors.push({ row: index, message: `Row has none of the identity fields (${rules.keyFields.join(', ')})` }); return; }
    if (seen.has(key)) { plan.errors.push({ row: index, message: 'Duplicate identity in the import' }); return; }
    seen.add(key); next.set(key, row);
  });
  if (plan.errors.length) return plan;
  const now = new Map<string, Row>();
  for (const row of current) { const key = entryKey(registerId, row); if (key !== null) now.set(key, row); }

  if (now.size === 0) {
    // One SEED carries the whole initial state: it is the only full-state action and replay seeds once.
    // The server accepts it from ITU staff only, and only while the register is still empty.
    plan.added = next.size;
    plan.actions.push({ type: 'SEED', data: { _class: cls, entries: [...next.values()] } });
    return plan;
  }
  const adds: Row[] = [], reps: Row[] = [], sups: Row[] = [];
  for (const [key, row] of next) {
    const old = now.get(key);
    if (!old) adds.push(row);
    else if (stable(old) !== stable(row)) reps.push(row);
    else plan.unchanged++;
  }
  const country = AMENDMENT_COUNTRY_FIELDS[cls];
  const keep = [...new Set([...rules.keyFields, ...rules.fallbackKeyFields.flat(), ...(country ? [country] : [])])];
  for (const [key, old] of now) if (!next.has(key)) sups.push(Object.fromEntries(keep.filter(f => old[f] !== undefined).map(f => [f, old[f]])));
  plan.added = adds.length; plan.replaced = reps.length; plan.superseded = sups.length;
  for (const [type, rows] of [['ADD', adds], ['REP', reps], ['SUP', sups]] as const)
    for (const part of chunks(rows, size)) plan.actions.push({ type, data: { _class: cls, entries: part } });
  return plan;
}
