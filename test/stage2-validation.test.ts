import { describe, expect, it } from "vitest";
import { registerStateFromSnapshot, stage1, stage2, validate, validateWithWarnings, type ActionType } from "../worker/lib/validation.ts";

// Stage 2 (docs/submission-workflow.adoc): key semantics of an action against the
// register's current snapshot. Item shape is schemaStage's job; stage2 only judges keys.
const state = registerStateFromSnapshot("E118_IIN", {
  active_entries: [{ issue_id_number: "89001" }, { issue_id_number: "89002" }],
  lapsed_keys: ["89003"],
});
const payload = (...ids: string[]) => ({ type: "ADD", data: { _class: "E118Amendment", entries: ids.map((id) => ({ issue_id_number: id, company_name: "Co" })) } });
const run = (action_type: ActionType, ids: string[], register_state: typeof state | null = state) =>
  stage2({ register_id: "E118_IIN", action_type, payload: payload(...ids), register_state: register_state ?? undefined });

describe("stage2 key semantics", () => {
  it("is silent without a snapshot (hook stays pluggable, CI replay is authoritative)", () => {
    expect(run("ADD", ["89001"], null)).toEqual([]);
  });
  it("accepts ADD of a new key and REP/MOD/SUP/DEL/LIR of known keys", () => {
    expect(run("ADD", ["89999"])).toEqual([]);
    for (const a of ["REP", "MOD", "SUP", "DEL", "LIR"] as const) expect(run(a, ["89001", "89003"])).toEqual([]);
  });
  it("accepts new SEED keys in an empty register while rejecting duplicates", () => {
    const context = { register_id: "E118_IIN", action_type: "SEED" as const,
      payload: { type: "SEED", data: { _class: "E118Amendment", entries: [{ issue_id_number: "new", company_name: "Co", country_or_area: { en: "France" } }] } },
      register_state: { active: new Set<string>(), lapsed: new Set<string>(), stale: true } };
    expect(validateWithWarnings(context)).toEqual({ errors: [], warnings: [] });
    expect(stage2({ ...context, payload: payload("new", "new") })).toEqual([
      expect.objectContaining({ path: "data.entries[1].issue_id_number", message: expect.stringContaining("more than once") }),
    ]);
  });
  it("rejects ADD of an active key, anchored to the entry", () => {
    expect(run("ADD", ["89999", "89001"])).toEqual([
      expect.objectContaining({ path: "data.entries[1].issue_id_number", code: "mismatch", message: expect.stringContaining("89001") }),
    ]);
  });
  it("rejects REP/MOD/SUP/DEL of a key that does not exist", () => {
    for (const a of ["REP", "MOD", "SUP", "DEL"] as const)
      expect(run(a, ["70000"]).map((e) => e.path)).toEqual(["data.entries[0].issue_id_number"]);
  });
  it("rejects a key repeated inside one payload even without a snapshot", () => {
    const errs = run("ADD", ["89999", "89999"], null);
    expect(errs).toEqual([expect.objectContaining({ path: "data.entries[1].issue_id_number", code: "mismatch" })]);
  });
  it("is part of the default chain: validate() reports it when the context carries state", () => {
    const errs = validate({ register_id: "E118_IIN", action_type: "ADD", payload: payload("89001"), register_state: state });
    expect(errs.some((e) => e.path === "data.entries[0].issue_id_number")).toBe(true);
    expect(validate({ register_id: "E118_IIN", action_type: "ADD", payload: payload("89001") }).filter((e) => e.message.includes("already exists"))).toEqual([]);
  });
});


describe("stage2 replay boundaries", () => {
  it("keeps case, surrounding whitespace and NBSP as distinct primary identities", () => {
    const keys = ["Co", "co", " Co ", "Co\u00a0", "\u00a0", " "];
    expect(run("ADD", keys, null)).toEqual([]);
    const exact = registerStateFromSnapshot("E118_IIN", { active_entries: keys.map(issue_id_number => ({ issue_id_number })) });
    expect([...exact.active]).toEqual(keys);
    expect(run("ADD", ["Co\u00a0"], exact)).toHaveLength(1);
    expect(run("ADD", ["CO"], exact)).toEqual([]);
  });
  it("uses canonical language order without skipping a whitespace primary cell", () => {
    const exact = registerStateFromSnapshot("NNP", { active_entries: [{ country_or_area: { fr: " ", en: "France" } }] });
    expect([...exact.active]).toEqual([" "]);
  });
  it("skips blank fallback groups but preserves exact nonblank fallback keys", () => {
    const exact = registerStateFromSnapshot("E164_CC", { active_entries: [{ cc_ic: "\u00a0" }, { cc_ic: " 800 " }, { country_code: " ", cc_ic: "801" }] });
    expect([...exact.active]).toEqual([" 800 ", " "]);
    const context = { register_id: "E164_CC", action_type: "ADD" as const, payload: { data: { _class: "E164CCAmendment", entries: [{ cc_ic: "\u00a0" }] } } };
    expect(stage1(context).some(e => e.code === "required")).toBe(true);
    expect(stage2({ ...context, payload: { data: { entries: [{ cc_ic: " 800 " }, { cc_ic: "800" }] } }, register_state: exact })).toHaveLength(1);
  });
  it("accepts LIR rows absent from the snapshot and lapsed identities", () => {
    expect(run("LIR", ["new", "89003"])).toEqual([]);
    expect(run("ADD", ["89003"])).toEqual([]);
  });
  it("handles large actions and reports a duplicate at its actual index", () => {
    const keys = Array.from({ length: 20000 }, (_, i) => String(i));
    const largePayload = payload(...keys);
    const entries = largePayload.data.entries.map(entry => ({ ...entry, country_or_area: { en: "France" } }));
    const context = { register_id: "E118_IIN", action_type: "ADD" as const,
      payload: { ...largePayload, data: { ...largePayload.data, entries } } };
    expect(validate(context)).toEqual([]);
    expect(validate({ ...context, payload: { ...context.payload, data: { ...context.payload.data, entries: [...entries, entries[12345]] } } }))
      .toEqual([expect.objectContaining({ path: "data.entries[20000].issue_id_number", message: expect.stringContaining("more than once") })]);
  });
});

describe("stale state warnings", () => {
  const context = (ids: string[], stale = true) => ({ register_id: "E118_IIN", action_type: "ADD" as const,
    payload: { ...payload(...ids), data: { ...payload(...ids).data, entries: ids.map(issue_id_number => ({ issue_id_number, company_name: "Co", country_or_area: { en: "France" } })) } },
    register_state: { ...state, stale } });
  it("returns advisory state conflicts separately while preserving validate's array contract", () => {
    const result = validateWithWarnings(context(["89001"]));
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([expect.objectContaining({ path: "data.entries[0].issue_id_number", message: expect.stringContaining("already exists") })]);
    expect(validate(context(["89001"]))).toEqual([]);
  });
  it("keeps fresh conflicts blocking and does not downgrade payload-local duplicates", () => {
    const fresh = validateWithWarnings(context(["89001"], false));
    expect(fresh.errors).toHaveLength(1);
    expect(fresh.warnings).toEqual([]);
    const stale = validateWithWarnings(context(["89001", "89001"]));
    expect(stale.errors).toEqual([expect.objectContaining({ path: "data.entries[1].issue_id_number", message: expect.stringContaining("more than once") })]);
    expect(stale.warnings).toHaveLength(1);
  });
  it("warns for missing keys across each state-dependent action", () => {
    for (const action_type of ["REP", "MOD", "SUP", "DEL"] as const) {
      const result = validateWithWarnings({ ...context(["missing"]), action_type, payload: { ...context(["missing"]).payload, type: action_type } });
      expect(result.errors).toEqual([]);
      expect(result.warnings).toHaveLength(1);
    }
  });
});
