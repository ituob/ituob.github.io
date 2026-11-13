// Submit-time validation, stage 1 (action envelope) — docs/submission-workflow.adoc "two stages".
//
// The chain is [stage1, schemaStage]. stage1 is the hand-written action
// envelope (key binding, per-action presence rules). schemaStage runs the
// validators GENERATED from the LML ontology (src/lib/schema.validators.generated.ts,
// second output of service-publications-docs scripts/generate_ts_types.rb):
// the same classes the Ruby gem compiles, so scalar types, collections, enums
// and unknown keys are checked against the ontology, not a hand-kept table.
// CI stays authoritative; this is the fast door check. The chain is PLUGGABLE.

import { PUBLICATION_BY_ID, REGISTERS } from "../../src/lib/catalogs.ts";
import { AMENDMENT_CLASSES, validateClass } from "../../src/lib/schema.validators.generated.ts";

export interface FieldError {
  path: string;
  code: "required" | "type" | "enum" | "mismatch" | "unknown";
  message: string;
}

export const ACTION_TYPES = ["ADD", "SUP", "REP", "LIR", "MOD", "DEL"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export interface ValidationContext {
  register_id: string;
  slug?: string;
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
  "R_SP_LN.VIII": { keyField: "country", requiredEntryFields: [] },
};
const DEFAULT_RULES: RegisterRules = { keyField: "country_or_area", requiredEntryFields: [] };
export const rulesFor = (register_id: string): RegisterRules => REGISTER_RULES[register_id] ?? DEFAULT_RULES;

/** IDs and filesystem destinations are catalog values, never a sanitized client path. */
export function submissionTargetErrors(register_id: string, slug?: string): FieldError[] {
  const target = PUBLICATION_BY_ID.get(register_id) ?? REGISTERS.find((r) => r.registerId === register_id);
  if (!target) return [{ path: "register_id", code: "unknown", message: "register_id must name a catalog publication or register" }];
  return slug !== undefined && target.slug !== slug
    ? [{ path: "slug", code: "mismatch", message: `slug must be ${target.slug} for ${register_id}` }]
    : [];
}

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

// LIR and SUP carry the repeated / superseded entries in the stored shape
// (measured over the corpus); the ontology has no `reason` or `superseded_by`
// attribute on an amendment, so the old LIR-reason and SUP-superseded_by
// presence rules contradicted the ontology and are gone.
const needsEntries: ReadonlySet<string> = new Set(["ADD", "REP", "MOD", "SUP", "DEL", "LIR"]);

export const stage1: PayloadValidator = ({ register_id, slug, action_type, payload }) => {
  const errs: FieldError[] = submissionTargetErrors(register_id, slug);
  const req = (path: string, message: string) => errs.push({ path, code: "required", message });
  if (!isObj(payload)) return [{ path: "", code: "type", message: "payload must be an object" }];
  if (payload.type !== undefined && payload.type !== action_type)
    errs.push({ path: "type", code: "mismatch", message: `type must equal the submission action ${action_type}` });
  if (!isObj(payload.data)) {
    req("data", "data is required");
    return errs;
  }
  const d = payload.data;
  if (typeof d._class !== "string" || !AMENDMENT_CLASSES.includes(d._class))
    errs.push({ path: "data._class", code: blank(d._class) ? "required" : "enum", message: "data._class must name the register's *Amendment class" });
  if (d.notes !== undefined && !(Array.isArray(d.notes) && d.notes.every((n) => typeof n === "string")))
    errs.push({ path: "data.notes", code: "type", message: "data.notes must be a list of strings" });

  // The ontology's TextAmendment has text/actions, not entry rows. Only
  // explicitly textual publications may use it; all fields still pass schemaStage.
  if (d._class === "TextAmendment") {
    if (PUBLICATION_BY_ID.get(register_id)?.classification !== "textual")
      errs.push({ path: "data._class", code: "mismatch", message: "TextAmendment requires a catalog textual publication" });
    if (blank(d.dataset_code)) req("data.dataset_code", "dataset_code is required for a text amendment");
    else if (d.dataset_code !== register_id)
      errs.push({ path: "data.dataset_code", code: "mismatch", message: "dataset_code must equal register_id" });
    if (blank(d.text)) req("data.text", "text is required for a text amendment");
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
    });
  }
  return errs;
};

/**
 * Ontology stage: the payload is the member-authored part of one ob-issues
 * action file. The Worker assigns `identifier`, `ob_issue_no`, `reference`
 * and the dates at approval (finalYaml), so the envelope is checked with a
 * stand-in identifier; `data` is checked against the amendment class its
 * `_class` names, with unknown keys rejected as the Ruby gate does.
 */
export const schemaStage: PayloadValidator = ({ payload }) => {
  if (!isObj(payload)) return [];
  const toError = (i: { path: string; code: FieldError["code"]; message: string }): FieldError => ({ path: i.path, code: i.code, message: i.message });
  const errs = validateClass("RegisterChange", { ...payload, identifier: payload.identifier ?? { code: "pending" } }).map(toError);
  const d = payload.data;
  if (!isObj(d)) return errs;
  const cls = d._class;
  if (typeof cls !== "string" || !AMENDMENT_CLASSES.includes(cls)) {
    if (cls !== undefined) errs.push({ path: "data._class", code: "enum", message: `data._class must be one of the register amendment classes` });
    return errs;
  }
  return errs.concat(validateClass(cls, d, "data").map(toError));
};

/** Stage 2 hook (item payloads vs register schema + key uniqueness vs snapshot). Intentionally empty: gap. */
export const stage2: PayloadValidator = () => [];

const DEFAULT_CHAIN: PayloadValidator[] = [stage1, schemaStage];
let active: PayloadValidator[] = DEFAULT_CHAIN;
/** Replace the validator chain (generator output, or a test double). */
export function setValidators(v: PayloadValidator[] | null) {
  active = v ?? DEFAULT_CHAIN;
}
export function validate(ctx: ValidationContext): FieldError[] {
  const seen = new Set<string>();
  // Two layers may report the same defect (e.g. a bad data._class); report it once.
  return active.flatMap((v) => v(ctx)).filter((e) => {
    const k = `${e.path}\u0000${e.code}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
}
