import assert from "node:assert/strict";
import { extname } from "node:path";
import { registerHooks } from "node:module";
import { test } from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier.startsWith(".") && !extname(specifier) ? `${specifier}.ts` : specifier, context);
  },
});
const { computeRunningAnnexes } = await import("../src/lib/loaders.ts");
const { formatObDate } = await import("../src/lib/ob-date.ts");
const publication = (issue, id) => computeRunningAnnexes(issue).find((entry) => entry.pubId === id);

test("pinned OB 1296 lists the E.212 MNC annex at OB 1280 with that event's position date", () => {
  const entry = publication(1296, "E212_MNC");
  assert.equal(entry?.annexed_in, 1280);
  assert.equal(entry?.position_on, "2023-11-14T23:00:00.000Z");
  assert.equal(formatObDate(entry.position_on), "14.XI.2023");
});

test("a second re-annexed publication uses its latest annex, and the list remains newest first", () => {
  const entries = computeRunningAnnexes(1296);
  const entry = publication(1296, "E118_IIN");
  assert.equal(entry?.annexed_in, 1283);
  assert.equal(formatObDate(entry.position_on), "31.XII.2023");
  assert.ok(entries.findIndex((item) => item.pubId === "E118_IIN") < entries.findIndex((item) => item.pubId === "E212_MNC"));
});

test("historical issues keep their then-current annex and never inherit a future event", () => {
  for (const issue of [1162, 1279]) {
    const entry = publication(issue, "E212_MNC");
    assert.equal(entry?.annexed_in, 1162);
    assert.equal(formatObDate(entry.position_on), "15.XII.2018");
    assert.ok(computeRunningAnnexes(issue).every((item) => item.annexed_in <= issue));
  }
});

test("the separate E.212 country-code publication keeps its own OB 1117 row", () => {
  const entry = publication(1296, "E212_ICC");
  assert.equal(entry?.annexed_in, 1117);
  assert.equal(formatObDate(entry.position_on), "1.II.2017");
});
