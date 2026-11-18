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
 * ADD has no before. MOD carries only the changed values, so only the fields it names are compared;
 * SUP/DEL show the whole current item as removed. Returns null when no current register data applies.
 */
export function currentItemDiffs(actionType: string, payload: unknown, current: CurrentRegisterItems | undefined): CurrentItemDiff[] | null {
  if (actionType === "ADD" || !current?.available) return null;
  const data = (payload as { data?: { entries?: unknown } } | undefined)?.data;
  const entries = Array.isArray(data?.entries) ? data.entries as unknown[] : [];
  if (!["REP", "MOD", "SUP", "DEL"].includes(actionType)) return null;
  return current.items.map((item, index) => {
    const proposed = entries[index];
    const object = proposed !== null && typeof proposed === "object" && !Array.isArray(proposed) ? proposed as Record<string, unknown> : {};
    let before: unknown = item.entry ?? undefined;
    if (actionType === "MOD" && item.entry) before = Object.fromEntries(Object.keys(object).filter(k => Object.hasOwn(item.entry!, k)).map(k => [k, item.entry![k]]));
    const after = actionType === "SUP" || actionType === "DEL" ? undefined : proposed;
    const changes = submissionFieldDiff(before, after).map(change => ({ ...change, path: change.path === "$" ? `entries[${index}]` : `entries[${index}].${change.path}` }));
    return { index, key: item.key, status: item.status, changes };
  });
}
