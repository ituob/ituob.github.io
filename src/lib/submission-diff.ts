export interface SubmissionFieldChange {
  path: string;
  before: string;
  after: string;
}

function display(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  return JSON.stringify(value, null, 2) ?? String(value);
}

function flatten(value: unknown, path: string, out: Map<string, string>) {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    if (!value.length) out.set(path, "[]");
    else value.forEach((item, index) => flatten(item, `${path}[${index}]`, out));
    return;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    if (!entries.length) out.set(path, "{}");
    else entries.forEach(([key, item]) => flatten(item, path ? `${path}.${key}` : key, out));
    return;
  }
  out.set(path || "$", display(value));
}

/** Return a stable field-level diff between two parsed YAML payloads. */
export function submissionFieldDiff(before: unknown, after: unknown): SubmissionFieldChange[] {
  const left = new Map<string, string>(), right = new Map<string, string>();
  flatten(before, "", left);
  flatten(after, "", right);
  return [...new Set([...left.keys(), ...right.keys()])]
    .sort()
    .filter((path) => left.get(path) !== right.get(path))
    .map((path) => ({ path, before: left.get(path) ?? "—", after: right.get(path) ?? "—" }));
}

export interface CurrentRegisterItem {
  key: string;
  status: "active" | "lapsed" | "unknown";
  entry: Record<string, unknown> | null;
}
export interface CurrentRegisterItems {
  available: boolean;
  items: CurrentRegisterItem[];
}

export interface CurrentItemDiff {
  index: number;
  key: string;
  status: CurrentRegisterItem["status"];
  changes: SubmissionFieldChange[];
}

/**
 * Field-level diff of each proposed entry against the register's CURRENT item (REP/MOD/SUP/DEL).
 * ADD has no before. MOD is compared against the replay-equivalent merge (nested hashes merge, nulls ignored; merge_strategy replace_full acts as REP);
 * SUP/DEL show the whole current item as removed. Returns null when no current register data applies.
 */
const isHash = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Replay's Strategies::Mod merge: Hash values merge recursively, null patch values are ignored. */
function modMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (isHash(v) && isHash(result[k])) result[k] = modMerge(result[k] as Record<string, unknown>, v);
    else if (v !== null && v !== undefined) result[k] = v;
  }
  return result;
}

export function currentItemDiffs(actionType: string, payload: unknown, current: CurrentRegisterItems | undefined): CurrentItemDiff[] | null {
  if (actionType === "ADD" || !current?.available) return null;
  const data = (payload as { data?: { entries?: unknown } } | undefined)?.data;
  const entries = Array.isArray(data?.entries) ? data.entries as unknown[] : [];
  if (!["REP", "MOD", "SUP", "DEL"].includes(actionType)) return null;
  return current.items.map((item, index) => {
    const proposed = entries[index];
    const object = proposed !== null && typeof proposed === "object" && !Array.isArray(proposed) ? proposed as Record<string, unknown> : {};
    const replace = actionType === "REP" || (actionType === "MOD" && (payload as { merge_strategy?: unknown }).merge_strategy === "replace_full");
    const before: unknown = item.entry ?? undefined;
    let after: unknown = proposed;
    if (actionType === "SUP" || actionType === "DEL") after = undefined;
    else if (!replace && item.entry) after = modMerge(item.entry, object);
    const changes = submissionFieldDiff(before, after).map(change => ({ ...change, path: change.path === "$" ? `entries[${index}]` : `entries[${index}].${change.path}` }));
    return { index, key: item.key, status: item.status, changes };
  });
}
