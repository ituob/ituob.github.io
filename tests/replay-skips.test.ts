import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";
import { explainSkips, parseReplaySkips } from "../src/lib/replay-skips.ts";

const TSV = [
  "register\tob_issue\tpatch\terror\tclass\tprint_ref",
  'E212_MNC\t1197\tp.yaml\t"skip SUP {""code"" => ""640 01""} at OB 1197: SUP conflict"\tG\titu-ob-data/issues/1197/amendments.yaml:154',
  'Q708_ISPC\t1109\tq.yaml\t"skip SUP {""code"" => ""4-082-6""} at OB 1109: x"\tE\tref2',
].join("\n");

test("ledger rows parse with quoted fields and unescape doubled quotes", () => {
  const rows = parseReplaySkips(TSV);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.error, 'skip SUP {"code" => "640 01"} at OB 1197: SUP conflict');
  assert.equal(rows[0]!.obIssue, 1197);
  assert.equal(rows[1]!.cls, "E");
});

test("every error gets a reason; unknown ones are listed as unclassified, not dropped", () => {
  const ledger = parseReplaySkips(TSV);
  const out = explainSkips(
    ['skip SUP {"code" => "640 01"} at OB 1197: SUP conflict', "skip LIR 12", "ADD already exists: x", "mystery"],
    "E212_MNC",
    ledger,
  );
  assert.equal(out.length, 4);
  assert.match(out[0]!.reason, /only printed mention/);
  assert.equal(out[0]!.printRef, "itu-ob-data/issues/1197/amendments.yaml:154");
  assert.match(out[1]!.reason, /printed-table position/);
  assert.match(out[2]!.reason, /already exists/);
  assert.match(out[3]!.reason, /Not yet classified/);
});

test("the real ledger classifies every row with a known class and print reference", { skip: !existsSync(new URL("../data-ob/docs/normalization/replay-skips.tsv", import.meta.url)) }, () => {
  const rows = parseReplaySkips(readFileSync(new URL("../data-ob/docs/normalization/replay-skips.tsv", import.meta.url), "utf8"));
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.match(r.cls, /^[SETDG]$/);
    assert.ok(r.printRef);
    const [skip] = explainSkips([r.error], r.register, rows);
    assert.notEqual(skip!.cls, null, r.error);
  }
});
