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
