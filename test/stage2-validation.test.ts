import { describe, expect, it } from "vitest";
import { registerStateFromSnapshot, stage2, validate, type ActionType } from "../worker/lib/validation.ts";

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
