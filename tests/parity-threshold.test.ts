import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/**
 * D100-1 CI gate: every included variant of the committed parity evidence must
 * score at least 95%. The evidence itself is produced by
 * test/generate_parity_evidence.rb from a full Jekyll reference build (about 43
 * minutes) plus a full Astro build, which is too slow for every pull request;
 * see docs/content-parity-certification.md "CI gate for the 95% threshold".
 * This test makes sure the committed receipts never record a failure.
 */
const root = new URL("../docs/parity/current-main/", import.meta.url).pathname;
const receipts = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(root, d.name, "parity_variants.json")))
  .map((d) => d.name);

interface Variant { deployed: string; coverage: number; verdict: string; exclusion: string | null }

test("committed parity receipts exist for the pinned and OB 1350 references", () => {
  assert.ok(receipts.includes("pinned"));
  assert.ok(receipts.includes("ob1350"));
});

for (const name of receipts) {
  test(`${name}: every included variant is at or above 95% and passes`, () => {
    const payload = JSON.parse(readFileSync(join(root, name, "parity_variants.json"), "utf8"));
    assert.equal(payload.threshold, 0.95);
    const variants: Variant[] = payload.variants;
    const included = variants.filter((v) => !v.exclusion);
    assert.equal(included.length, payload.included_variants);
    assert.ok(included.length > 0);
    const failing = included.filter((v) => !(v.coverage >= 0.95) || v.verdict !== "pass");
    assert.deepEqual(failing.map((v) => `${v.deployed} ${v.coverage} ${v.verdict}`), []);
    for (const v of variants.filter((x) => x.exclusion)) assert.ok(String(v.exclusion).length > 0);
  });
}
