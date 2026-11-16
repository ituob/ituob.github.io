import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CANDIDATE_LABEL, ADOPTED_LABEL, defaultManifestPath, groupPublications, isSafeRelativePath,
  loadPublications, parseManifest, pdfHref, statusPresentation,
} from "../src/lib/publications.ts";

const base = {
  standard: "E.212", title: "T", edition_year: 2026, language: "en", as_of_issue: 1170,
  sha256: "a".repeat(64), status: "candidate", register_slugs: ["e212-mnc"], path: "x/E.pdf",
};

test("fixture loads: 2 candidate + 1 itu-adopted, nothing rejected", () => {
  const { entries, rejected } = loadPublications();
  assert.deepEqual(rejected, []);
  assert.equal(entries.filter((e) => e.status === "candidate").length, 2);
  assert.equal(entries.filter((e) => e.status === "itu-adopted").length, 1);
  assert.ok(entries.every((e) => e.as_of_issue > 0));
});

test("manifest path is configurable via DOWNLOADS_MANIFEST", () => {
  const dir = mkdtempSync(join(tmpdir(), "dl-"));
  const file = join(dir, "m.json");
  writeFileSync(file, JSON.stringify([{ ...base, standard: "Q.708" }]));
  assert.equal(defaultManifestPath({ DOWNLOADS_MANIFEST: file }), file);
  assert.deepEqual(loadPublications(defaultManifestPath({ DOWNLOADS_MANIFEST: file })).entries.map((e) => e.standard), ["Q.708"]);
  assert.match(defaultManifestPath({}), /publications-manifest\.fixture\.json$/);
});

test("missing manifest file yields an empty list", () => {
  assert.deepEqual(loadPublications("/nonexistent/manifest.json"), { entries: [], rejected: [] });
});

test("invalid entries (failed render) are dropped and reported, not shown", () => {
  const bad = [
    { ...base, sha256: "xyz" }, { ...base, status: "official" }, { ...base, path: "../etc/passwd" },
    { ...base, as_of_issue: 0 }, { ...base, language: "" }, "junk",
    { ...base, language: "fr" },
  ];
  const { entries, rejected } = parseManifest(JSON.stringify(bad));
  assert.deepEqual(entries.map((e) => e.language), ["fr"]);
  assert.equal(rejected.length, 6);
});

test("duplicate standard+year+language is rejected", () => {
  const { entries, rejected } = parseManifest(JSON.stringify([base, base]));
  assert.equal(entries.length, 1);
  assert.equal(rejected.length, 1);
});

test("rejects a non-array manifest", () => {
  assert.throws(() => parseManifest("{}"), /expected an array/);
});

test("groups by Recommendation, then edition newest first, languages sorted", () => {
  const entries = [
    { ...base, standard: "F.32", edition_year: 2011 },
    { ...base, edition_year: 2020, language: "fr" },
    { ...base, edition_year: 2026, language: "fr" },
    { ...base, edition_year: 2026, language: "en" },
    { ...base, standard: "E.164", edition_year: 2010 },
  ] as never;
  const g = groupPublications(entries);
  assert.deepEqual(g.map((x) => x.standard), ["E.164", "E.212", "F.32"]);
  const e212 = g[1]!;
  assert.deepEqual(e212.editions.map((e) => e.edition_year), [2026, 2020]);
  assert.deepEqual(e212.editions[0]!.entries.map((e) => e.language), ["en", "fr"]);
});

test("natural order: E.9 before E.164", () => {
  const g = groupPublications([{ ...base, standard: "E.164" }, { ...base, standard: "E.9" }] as never);
  assert.deepEqual(g.map((x) => x.standard), ["E.9", "E.164"]);
});

test("candidate status: pending-adoption label and disclaimer retained", () => {
  const p = statusPresentation("candidate");
  assert.equal(p.label, CANDIDATE_LABEL);
  assert.equal(CANDIDATE_LABEL, "Generated from the patch log, pending ITU adoption");
  assert.equal(p.official, false);
  assert.equal(p.showDisclaimer, true);
});

test("itu-adopted status: presented as official, no disclaimer", () => {
  const p = statusPresentation("itu-adopted");
  assert.equal(p.label, ADOPTED_LABEL);
  assert.equal(p.official, true);
  assert.equal(p.showDisclaimer, false);
});

test("edition is official only when every language is adopted", () => {
  const mixed = groupPublications([
    { ...base, status: "itu-adopted" }, { ...base, language: "fr", status: "candidate" },
  ] as never);
  assert.equal(mixed[0]!.editions[0]!.status, "candidate");
  const all = groupPublications([{ ...base, status: "itu-adopted" }] as never);
  assert.equal(all[0]!.editions[0]!.status, "itu-adopted");
});

test("path safety and href", () => {
  for (const p of ["/abs.pdf", "a/../b.pdf", "https://x/y.pdf", "a\\b.pdf", "", "a//b.pdf"]) assert.equal(isSafeRelativePath(p), false, p);
  assert.equal(pdfHref({ path: "E.212/a b.pdf" }), "/downloads/E.212/a%20b.pdf");
});

test("an explicitly configured but missing manifest is an error, not an empty page", () => {
  process.env.DOWNLOADS_MANIFEST = "/nonexistent/manifest.json";
  try {
    assert.throws(() => loadPublications(), /DOWNLOADS_MANIFEST not found/);
  } finally {
    delete process.env.DOWNLOADS_MANIFEST;
  }
});
