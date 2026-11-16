import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { parse } from "yaml";

const directory = new URL("../docs/parity/printed-labels-notes/", import.meta.url);
const read = (name) => readFileSync(new URL(name, directory), "utf8");

test("the attached gate and every classified variant prove the four-type parity requirement", () => {
  const markdown = read("parity_report.md");
  const summary = parse(read("parity_report.yaml"));
  const evidence = JSON.parse(read("parity_variants.json"));
  assert.equal(evidence.threshold, 0.95);
  assert.equal(evidence.local_pages, 429);
  assert.equal(evidence.classified_variants, evidence.variants.length);
  for (const [path, sha] of Object.entries(evidence.source_sha256)) {
    const actual = createHash("sha256").update(readFileSync(new URL(`../${path}`, import.meta.url))).digest("hex");
    assert.equal(actual, sha, `${path}: evidence belongs to the current source`);
  }
  const included = evidence.variants.filter((row) => !row.exclusion);
  assert.equal(included.length, evidence.included_variants);
  assert.equal(evidence.excluded_variants, 2, "only the canonical cross-listed exceptions are excluded");
  assert.deepEqual([...new Set(included.map((row) => row.label.split("/")[0]))].sort(), ["index", "issue", "recommendation", "register"]);
  for (const row of included) {
    assert.ok(row.coverage >= 0.95 && row.coverage <= 1, `${row.deployed}: ${row.coverage}`);
    assert.equal(row.verdict, "pass", row.deployed);
    assert.match(row.deployed_sha256, /^[a-f0-9]{64}$/);
    assert.match(row.local_sha256, /^[a-f0-9]{64}$/);
  }
  const localRows = Object.values(summary).flat();
  assert.equal(localRows.length, 429);
  for (const row of localRows) {
    const label = row[":label"] ?? row.label;
    const coverage = row[":coverage"] ?? row.coverage;
    const variants = included.filter((variant) => variant.label === label);
    assert.ok(variants.length > 0, label);
    assert.equal(coverage, Math.min(...variants.map((variant) => variant.coverage)), `${label} uses its worst variant`);
    assert.equal(row[":verdict"] ?? row.verdict, "pass", label);
  }
  assert.ok(markdown.includes("Worst-variant rule"));
  assert.ok(read("parity_variants.csv").includes("deployed,local,label,coverage,verdict"));
});

test("the evidence and instructions use portable paths", () => {
  for (const name of ["README.md", "parity_report.md", "parity_report.yaml", "parity_variants.json", "parity_variants.csv"]) {
    assert.doesNotMatch(read(name), /\/Users\/|\/private\/|\/tmp\//, name);
  }
});
