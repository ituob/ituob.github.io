import { describe, expect, it } from "vitest";
import { submissionFieldDiff } from "../submission-diff";

describe("submissionFieldDiff", () => {
  it("reports changed, added, and removed nested fields in stable path order", () => {
    expect(submissionFieldDiff(
      { data: { entries: [{ code: "A", name: "Old", retired: true }] } },
      { data: { entries: [{ code: "A", name: "New", active: true }] } },
    )).toEqual([
      { path: "data.entries[0].active", before: "—", after: "true" },
      { path: "data.entries[0].name", before: '"Old"', after: '"New"' },
      { path: "data.entries[0].retired", before: "true", after: "—" },
    ]);
  });

  it("does not report unchanged values and handles an initial proposal", () => {
    expect(submissionFieldDiff(undefined, { type: "ADD", data: { code: "X" } })).toEqual([
      { path: "data.code", before: "—", after: '"X"' },
      { path: "type", before: "—", after: '"ADD"' },
    ]);
    expect(submissionFieldDiff({ type: "ADD" }, { type: "ADD" })).toEqual([]);
  });
});

import { currentItemDiffs } from "../submission-diff";

describe("currentItemDiffs", () => {
  const item = { key: "A", status: "active" as const, entry: { code: "A", name: "Old", note: "keep" } };
  const current = { available: true, items: [item] };
  const payload = (entry: unknown) => ({ data: { entries: [entry] } });

  it("REP compares the whole current item with the proposed entry", () => {
    expect(currentItemDiffs("REP", payload({ code: "A", name: "New" }), current)![0]!.changes).toEqual([
      { path: "entries[0].name", before: '"Old"', after: '"New"' },
      { path: "entries[0].note", before: '"keep"', after: "—" },
    ]);
  });
  it("MOD compares only the fields it carries", () => {
    expect(currentItemDiffs("MOD", payload({ code: "A", name: "New" }), current)![0]!.changes).toEqual([
      { path: "entries[0].name", before: '"Old"', after: '"New"' },
    ]);
  });
  it("SUP and DEL show the current item as removed", () => {
    for (const type of ["SUP", "DEL"]) expect(currentItemDiffs(type, payload({ code: "A" }), current)![0]!.changes.map(c => [c.path, c.after])).toEqual([
      ["entries[0].code", "—"], ["entries[0].name", "—"], ["entries[0].note", "—"],
    ]);
  });
  it("an item absent from the register has no before; ADD and unavailable data have no comparison", () => {
    const missing = { available: true, items: [{ key: "Z", status: "unknown" as const, entry: null }] };
    expect(currentItemDiffs("REP", payload({ code: "Z" }), missing)![0]!.changes).toEqual([{ path: "entries[0].code", before: "—", after: '"Z"' }]);
    expect(currentItemDiffs("ADD", payload({ code: "Z" }), current)).toBeNull();
    expect(currentItemDiffs("REP", payload({ code: "A" }), { available: false, items: [] })).toBeNull();
  });
});
