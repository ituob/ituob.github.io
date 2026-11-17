import { AMENDMENT_COUNTRY_FIELDS, REGISTER_IDENTITIES } from '../register-rules.generated';
import { PUBLICATION_BY_ID, REGISTERS } from '../catalogs';
// The server's own validator (envelope + ontology), so a plan is offered only when every action would pass it.
import { validate, type ActionType } from '../../../worker/lib/validation';

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
  /** Rows the server's validator rejects are listed in `errors` (one entry per row) and no action is planned for the import. */
  /** Reserved: a reason the series cannot be submitted, or null when every action can go through review. */
  blocked: string | null;
}
type Row = Record<string, unknown>;
const isRow = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v);

/** Replay's String#strip: ASCII whitespace only. A no-break space is data, not padding, so it is kept. */
const strip = (text: string) => text.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, '');
function part(value: unknown): string | null {
  if (typeof value === 'string') return strip(value) || null;
  if (!isRow(value)) return null;
  for (const language of ['fr', 'en', 'es', 'zh', 'ru', 'ar']) {
    const text = value[language];
    if (typeof text === 'string' && strip(text)) return strip(text);
  }
  return null;
}
/**
 * True when the server accepts submissions for this register: it must name a catalog publication or register
 * under exactly this slug (the server's submissionTargetErrors) and have a typed amendment class.
 */
export function importableRegister(registerId: string, slug: string): boolean {
  const target = PUBLICATION_BY_ID.get(registerId) ?? REGISTERS.find(r => r.registerId === registerId);
  return !!target && target.slug === slug && !!REGISTER_IDENTITIES[registerId]?.amendmentClass;
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

/**
 * Runs the server's validate() over every planned action and reports each failing import row once, with the
 * server's messages. Nothing is repaired or dropped: a row the server would refuse (a missing country, a
 * mistyped field) is the data's defect and has to be fixed in the list, not guessed at here.
 */
function rejectedByServer(registerId: string, slug: string, actions: PlannedAction[], rowOf: Map<Row, number>): ImportPlan['errors'] {
  const byRow = new Map<number | null, Set<string>>();
  for (const action of actions) {
    for (const e of validate({ register_id: registerId, slug, action_type: action.type as ActionType, payload: { type: action.type, data: action.data } })) {
      const at = /^data\.entries\[(\d+)\]/.exec(e.path);
      const entry = at ? action.data.entries[Number(at[1])] : undefined;
      const row = entry ? rowOf.get(entry) ?? null : null;
      const messages = byRow.get(row) ?? new Set<string>();
      messages.add(e.message); byRow.set(row, messages);
    }
  }
  return [...byRow].map(([row, messages]) => ({ row, message: `The server would reject ${row === null ? 'this change' : 'this row'}: ${[...messages].join('; ')}` })).sort((a, b) => (a.row ?? Infinity) - (b.row ?? Infinity));
}

export function planImport(registerId: string, current: Row[], imported: unknown, options: { chunkSize?: number } = {}): ImportPlan {
  const plan: ImportPlan = { actions: [], added: 0, replaced: 0, superseded: 0, unchanged: 0, errors: [], blocked: null };
  const rules = REGISTER_IDENTITIES[registerId];
  const target = PUBLICATION_BY_ID.get(registerId) ?? REGISTERS.find(r => r.registerId === registerId);
  if (!target || !rules?.amendmentClass) { plan.errors.push({ row: null, message: target ? `${registerId} has no typed register class; use the text amendment form` : `${registerId} is not a catalog register the server accepts submissions for` }); return plan; }
  if (!Array.isArray(imported) || imported.length === 0) { plan.errors.push({ row: null, message: 'The import must be a non-empty list of rows' }); return plan; }
  const size = Math.max(1, options.chunkSize ?? 50), cls = rules.amendmentClass;
  const next = new Map<string, Row>(), seen = new Set<string>(), rowOf = new Map<Row, number>();
  imported.forEach((row, index) => {
    if (!isRow(row)) { plan.errors.push({ row: index, message: 'Row must be an object' }); return; }
    const key = entryKey(registerId, row);
    if (key === null) { plan.errors.push({ row: index, message: `Row has none of the identity fields (${rules.keyFields.join(', ')})` }); return; }
    if (seen.has(key)) { plan.errors.push({ row: index, message: 'Duplicate identity in the import' }); return; }
    seen.add(key); next.set(key, row); rowOf.set(row, index);
  });
  if (plan.errors.length) return plan;
  const now = new Map<string, Row>();
  for (const row of current) { const key = entryKey(registerId, row); if (key !== null) now.set(key, row); }

  if (now.size === 0) {
    // One SEED carries the whole initial state: it is the only full-state action and replay seeds once.
    // The server accepts it from ITU staff only, and only while the register is still empty.
    const seed: PlannedAction = { type: 'SEED', data: { _class: cls, entries: [...next.values()] } };
    plan.errors.push(...rejectedByServer(registerId, target.slug, [seed], rowOf));
    if (plan.errors.length) return plan;
    plan.added = next.size;
    plan.actions.push(seed);
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
  for (const [key, old] of now) if (!next.has(key)) {
    // The server requires the country field on every entry, so a row without one cannot be superseded.
    if (country && part(old[country]) === null)
      plan.errors.push({ row: null, message: `Cannot supersede "${key.split('\u0001').filter(Boolean).join(' ')}": the register row has no ${country}, which every SUP entry requires. Fix the row's ${country} first` });
    sups.push(Object.fromEntries(keep.filter(f => old[f] !== undefined).map(f => [f, old[f]])));
  }
  if (plan.errors.length) return plan;
  const actions: PlannedAction[] = [];
  for (const [type, rows] of [['ADD', adds], ['REP', reps], ['SUP', sups]] as const)
    for (const part of chunks(rows, size)) actions.push({ type, data: { _class: cls, entries: part } });
  plan.errors.push(...rejectedByServer(registerId, target.slug, actions, rowOf));
  if (plan.errors.length) return plan;
  plan.added = adds.length; plan.replaced = reps.length; plan.superseded = sups.length;
  plan.actions = actions;
  return plan;
}
