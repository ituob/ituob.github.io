// Submit-time validation, stage 1 (action envelope) — docs/submission-workflow.adoc "two stages".
//
// MEASURED PREMISE (2026-11-11): src/lib/schema.generated.ts is interfaces only
// (every field optional, no enums, no required, no runtime validator;
// `grep -c required` = 0) and the `data`/`data-ob` submodules (which hold the
// per-register schema-data.yaml) are not checked out here. So the validator is
// PLUGGABLE: stage 1 below is hand-written from the design note's envelope
// rules, and per-register rules come from `RegisterRules` tables that a
// generator (ituob.github.io scripts/generate_ts_types.rb, second output
// schema.validators.generated.ts) should replace. CI stays authoritative.

export interface FieldError {
  path: string;
  code: "required" | "type" | "enum" | "mismatch";
  message: string;
}

export const ACTION_TYPES = ["ADD", "SUP", "REP", "LIR", "MOD", "DEL"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export interface ValidationContext {
  register_id: string;
  action_type: ActionType;
  payload: unknown;
}
export type PayloadValidator = (ctx: ValidationContext) => FieldError[];

/** Per-register rules. INTERIM hand-maintained table (gap: generate from messages.lml / schema-data.yaml). */
export interface RegisterRules {
  /** Entry field holding the country/area register_key, used for country binding. */
  keyField: string;
  /** Entry fields that must be non-empty for ADD/REP. */
  requiredEntryFields: string[];
}
export const REGISTER_RULES: Record<string, RegisterRules> = {
  E118_IIN: { keyField: "country_or_area", requiredEntryFields: ["company_name"] },
};
const DEFAULT_RULES: RegisterRules = { keyField: "country_or_area", requiredEntryFields: [] };
export const rulesFor = (register_id: string): RegisterRules => REGISTER_RULES[register_id] ?? DEFAULT_RULES;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const blank = (v: unknown) =>
  v === undefined || v === null || (typeof v === "string" && v.trim() === "") ||
  (Array.isArray(v) && v.length === 0) || (isObj(v) && Object.keys(v).length === 0);

/** String value of a key field: plain string, or a multilingual object's `en`/first value. */
function keyOf(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (isObj(v)) {
    const x = v.en ?? Object.values(v)[0];
    return typeof x === "string" && x.trim() ? x.trim() : null;
  }
  return null;
}

/** Country keys derived server-side from the payload (never a client-supplied member id). */
export function registerKeysOf(register_id: string, payload: unknown): string[] {
  const entries = isObj(payload) && isObj(payload.data) && Array.isArray(payload.data.entries) ? payload.data.entries : [];
  const field = rulesFor(register_id).keyField;
  const keys: string[] = [];
  for (const e of entries) {
    const k = isObj(e) ? keyOf(e[field]) : null;
    if (k) keys.push(k);
  }
  return keys;
}

const needsEntries: ReadonlySet<string> = new Set(["ADD", "REP", "MOD", "SUP", "DEL"]);

export const stage1: PayloadValidator = ({ register_id, action_type, payload }) => {
  const errs: FieldError[] = [];
  const req = (path: string, message: string) => errs.push({ path, code: "required", message });
  if (!isObj(payload)) return [{ path: "", code: "type", message: "payload must be an object" }];
  if (payload.type !== undefined && payload.type !== action_type)
    errs.push({ path: "type", code: "mismatch", message: `type must equal the submission action ${action_type}` });
  if (!isObj(payload.data)) {
    req("data", "data is required");
    return errs;
  }
  const d = payload.data;
  if (typeof d._class !== "string" || !/^[A-Za-z0-9]+Amendment$/.test(d._class))
    errs.push({ path: "data._class", code: blank(d._class) ? "required" : "enum", message: "data._class must name the register's *Amendment class" });
  if (d.notes !== undefined && !(Array.isArray(d.notes) && d.notes.every((n) => typeof n === "string")))
    errs.push({ path: "data.notes", code: "type", message: "data.notes must be a list of strings" });

  if (action_type === "LIR") {
    // UNVERIFIED shape: rules live in datasets/schema-change.yaml (not available here).
    if (blank(d.reason)) req("data.reason", "LIR requires a reason");
    return errs;
  }
  if (needsEntries.has(action_type)) {
    if (!Array.isArray(d.entries) || d.entries.length === 0) {
      req("data.entries", `${action_type} requires at least one entry`);
      return errs;
    }
    const rules = rulesFor(register_id);
    const full = action_type === "ADD" || action_type === "REP";
    d.entries.forEach((e, i) => {
      const at = `data.entries[${i}]`;
      if (!isObj(e)) return errs.push({ path: at, code: "type", message: "entry must be an object" });
      if (keyOf(e[rules.keyField]) === null) req(`${at}.${rules.keyField}`, `${rules.keyField} is required`);
      if (full) for (const f of rules.requiredEntryFields) if (blank(e[f])) req(`${at}.${f}`, `${f} is required`);
      if (action_type === "SUP" && blank(e.superseded_by)) req(`${at}.superseded_by`, "SUP requires superseded_by");
    });
  }
  return errs;
};

/** Stage 2 hook (item payloads vs register schema + key uniqueness vs snapshot). Intentionally empty: gap. */
export const stage2: PayloadValidator = () => [];

let active: PayloadValidator[] = [stage1];
/** Replace the validator chain (generator output, or a test double). */
export function setValidators(v: PayloadValidator[] | null) {
  active = v ?? [stage1];
}
export function validate(ctx: ValidationContext): FieldError[] {
  return active.flatMap((v) => v(ctx));
}
