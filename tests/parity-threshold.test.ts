import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/**
 * D100-1 CI gate for the 95% parity threshold. Three independent checks on the
 * committed receipts in docs/parity/current-main/<name>/parity_variants.json:
 *
 *  1. every included variant scores at least 95% and passes (threshold);
 *  2. the "pinned" receipt (the only one the hosted workflow can regenerate)
 *     was scored with the current metric, multiset-token-containment;
 *  3. the "pinned" receipt is not stale: every source file it hashed
 *     (source_sha256) still has that hash. A changed hashed template means the
 *     receipt describes output this tree no longer produces.
 *
 * Receipts are produced by test/generate_parity_evidence.rb from a full Jekyll
 * reference build plus an Astro audit build, run by the "Parity re-measure"
 * workflow (.github/workflows/parity-remeasure.yml). See
 * docs/content-parity-certification.md "CI gate for the 95% threshold".
 * PARITY_RECEIPTS_ROOT and PARITY_SOURCE_ROOT exist only so the checks can be
 * mutation-tested against a copy; CI leaves them unset.
 */
const repo = new URL("../", import.meta.url).pathname;
const root = process.env.PARITY_RECEIPTS_ROOT ?? join(repo, "docs/parity/current-main");
const sourceRoot = process.env.PARITY_SOURCE_ROOT ?? repo;
const REGENERATE =
  "Regenerate: run the 'Parity re-measure' workflow (.github/workflows/parity-remeasure.yml, " +
  "workflow_dispatch), download the parity-receipts artifact and commit it over " +
  "docs/parity/current-main/pinned/. Local alternative: test/generate_parity_evidence.rb " +
  "(needs a ~43 min Jekyll reference build; see docs/content-parity-certification.md).";

interface Variant { deployed: string; coverage: number; verdict: string; exclusion: string | null }
interface Payload {
  metric?: string; threshold: number; included_variants: number;
  source_sha256: Record<string, string>; variants: Variant[];
}

const receipts = existsSync(root)
  ? readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(root, d.name, "parity_variants.json")))
      .map((d) => d.name)
  : [];
const load = (name: string): Payload =>
  JSON.parse(readFileSync(join(root, name, "parity_variants.json"), "utf8"));

test("committed parity receipts exist for the pinned and OB 1350 references", () => {
  assert.ok(existsSync(root), `receipts directory is missing: ${root}. ${REGENERATE}`);
  for (const name of ["pinned", "ob1350"]) {
    assert.ok(receipts.includes(name), `missing receipt ${name}/parity_variants.json. ${REGENERATE}`);
  }
});

for (const name of receipts) {
  test(`${name}: every included variant is at or above 95% and passes`, () => {
    const payload = load(name);
    assert.equal(payload.threshold, 0.95);
    const included = payload.variants.filter((v) => !v.exclusion);
    assert.equal(included.length, payload.included_variants);
    assert.ok(included.length > 0);
    const failing = included.filter((v) => !(v.coverage >= 0.95) || v.verdict !== "pass");
    assert.deepEqual(failing.map((v) => `${v.deployed} ${v.coverage} ${v.verdict}`), []);
    for (const v of payload.variants.filter((x) => x.exclusion)) assert.ok(String(v.exclusion).length > 0);
  });
}

test("pinned receipt was scored with multiset-token-containment", () => {
  if (!receipts.includes("pinned")) assert.fail(`no pinned receipt. ${REGENERATE}`);
  assert.equal(
    load("pinned").metric,
    "multiset-token-containment",
    `the pinned receipt predates the count-aware metric (unique-token scores overstate parity). ${REGENERATE}`,
  );
});

test("pinned receipt is not stale against the sources it hashed", () => {
  if (!receipts.includes("pinned")) assert.fail(`no pinned receipt. ${REGENERATE}`);
  const hashes = load("pinned").source_sha256 ?? {};
  assert.ok(Object.keys(hashes).length > 0, `pinned receipt records no source_sha256. ${REGENERATE}`);
  const stale = Object.entries(hashes).filter(([path, recorded]) => {
    const file = join(sourceRoot, path);
    if (!existsSync(file)) return true;
    return createHash("sha256").update(readFileSync(file)).digest("hex") !== recorded;
  }).map(([path]) => path);
  assert.deepEqual(stale, [], `stale receipt: these sources changed since it was measured. ${REGENERATE}`);
});
