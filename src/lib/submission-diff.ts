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
