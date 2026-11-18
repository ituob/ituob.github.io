import { test } from "node:test";
import assert from "node:assert/strict";
import { computeJekyllSeqNos, jekyllPosition, samePosition, type SeqIssue } from "../src/lib/jekyll-seqno.ts";

const slugOf = (id: string) => id.toLowerCase();
const msg = (publication: string, positionOn: unknown) => ({ type: "amendment", publication, positionOn });

test("bare date equals a 23:00Z timestamp the day before, not a UTC-midnight one", () => {
  assert.equal(samePosition(jekyllPosition("2015-01-01"), jekyllPosition("2014-12-31T23:00:00.000Z")), true);
  assert.equal(samePosition(jekyllPosition("2014-09-15"), jekyllPosition("2014-09-15T00:00:00.000Z")), false);
});

test("OB 1100 ISPC counts (31); OB 1167 Carrier Codes gets no number", () => {
  const seed: SeqIssue[] = [
    { id: 1, publicationDate: "2014-12-01", messages: [], annexes: { ispc: { position_on: "2014-12-31T23:00:00.000Z" }, icc: { position_on: "2014-09-15T00:00:00.000Z" } } },
    { id: 2, publicationDate: "2015-01-15", messages: [msg("ispc", "2015-01-01"), msg("icc", "2014-09-15")], annexes: {} },
  ];
  const r = computeJekyllSeqNos(seed, slugOf);
  assert.equal(r.get(2)?.get("ispc"), 1);
  assert.equal(r.get(2)?.has("icc"), false);
});

test("a summer local midnight (T22:00:00Z) is not equal to a bare date: production behaviour there is unobserved, Ruby says unequal", () => {
  assert.equal(samePosition(jekyllPosition("2010-05-15"), jekyllPosition("2010-05-14T22:00:00.000Z")), false);
});

test("a timestamp with a numeric offset is a Time like in Psych, so it takes part in numbering", () => {
  assert.deepEqual(jekyllPosition("2015-01-01T00:00:00+01:00"), { kind: "time", value: "2015-01-01T00:00:00+01:00" });
  assert.equal(samePosition(jekyllPosition("2015-01-01T00:00:00+01:00"), jekyllPosition("2014-12-31T23:00:00Z")), true);
  assert.equal(samePosition(jekyllPosition("2015-01-01"), jekyllPosition("2015-01-01T00:00:00+01:00")), false);
  const issues: SeqIssue[] = [
    { id: 1, publicationDate: "2015-01-01", messages: [], annexes: { P: { position_on: "2015-01-01T00:00:00+01:00" } } },
    { id: 2, publicationDate: "2015-01-15", messages: [{ type: "amendment", publication: "P" }], annexes: {} },
  ];
  assert.equal(computeJekyllSeqNos(issues, (p) => p).get(2)?.get("P"), 1);
});
