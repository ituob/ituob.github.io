import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
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
  assert.deepEqual(Object.keys(evidence.source_sha256).sort(), [
    "src/lib/printed-context.ts", "src/lib/loaders.ts", "src/lib/ob-date.ts",
    "src/components/PrintedRegisterContext.astro", "src/components/IncompleteBanner.astro",
    "src/components/ProseMirror.astro", "src/pages/issues/[id]/index.astro",
    "src/pages/registers/[slug]/index.astro", "package-lock.json",
  ].sort(), "the audit-time source manifest cannot be empty or partial");
  for (const [path, sha] of Object.entries(evidence.source_sha256)) {
    const actual = createHash("sha256").update(readFileSync(new URL(`../${path}`, import.meta.url))).digest("hex");
    assert.equal(actual, sha, `${path}: audit-time source remains unchanged`);
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
  for (const name of ["README.md", "parity_report.md", "parity_report.yaml", "parity_variants.json", "parity_variants.csv", "build_inputs.json"]) {
    assert.doesNotMatch(read(name), /\/Users\/|\/private\/|\/tmp\//, name);
  }
});

test("the removed annex chronology has an actionable follow-up draft", () => {
  const draft = read("annex-follow-up.md");
  for (const url of [
    "https://github.com/ituob/ituob.github.io/issues/100",
    "https://github.com/ituob/ituob.github.io/pull/111",
    "https://github.com/ituob/ituob.github.io/issues/61",
  ]) assert.ok(draft.includes(url), url);
  assert.match(draft, /71083bf9696f1c11f280fcc87585b0ce6463bde2/);
  assert.match(draft, /E\.118/);
  assert.match(draft, /E\.212/);
  assert.match(draft, /position_on/);
  assert.ok(read("README.md").includes("annex-follow-up.md"));
});

test("the successful fixture build used the recorded source inputs", () => {
  const build = JSON.parse(read("build_inputs.json"));
  assert.equal(build.audited_routes, 429);
  assert.equal(build.status, "success");
  assert.ok(Date.parse(build.completed_at) >= Date.parse(build.started_at));
  const sourceRoot = new URL("../src/", import.meta.url);
  const paths = readdirSync(sourceRoot, { recursive: true })
    .map(path => `src/${path}`)
    .filter(path => statSync(new URL(`../${path}`, import.meta.url)).isFile());
  paths.push("package-lock.json", "astro.config.mjs", "register-snapshots.integration.mjs");
  assert.deepEqual(Object.keys(build.source_sha256).sort(), paths.sort(), "complete build input inventory");
  for (const [path, sha] of Object.entries(build.source_sha256)) {
    const actual = createHash("sha256").update(readFileSync(new URL(`../${path}`, import.meta.url))).digest("hex");
    assert.equal(actual, sha, `${path}: build inputs remain unchanged`);
  }
  const audit = JSON.parse(read("parity_variants.json"));
  for (const [path, sha] of Object.entries(audit.source_sha256)) {
    assert.equal(build.source_sha256[path], sha, `${path}: audit matches the recorded build inputs`);
  }
});
