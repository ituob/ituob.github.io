import assert from "node:assert/strict";
import { test } from "node:test";
import { editionAdopted, isAdopted } from "../src/lib/adoption.ts";

const f = (language: string, sha256: string) => ({ standard: "E.212", edition_year: 2011, language, sha256 });

test("adopted only on an exact standard/edition/language/sha256 match", () => {
  const recs = [f("en", "a".repeat(64))];
  assert.equal(isAdopted(f("en", "a".repeat(64)), recs), true);
  assert.equal(isAdopted(f("en", "b".repeat(64)), recs), false);
  assert.equal(isAdopted(f("fr", "a".repeat(64)), recs), false);
});

test("an edition is adopted only when every language file is", () => {
  const recs = [f("en", "a".repeat(64))];
  assert.equal(editionAdopted([f("en", "a".repeat(64))], recs), true);
  assert.equal(editionAdopted([f("en", "a".repeat(64)), f("fr", "c".repeat(64))], recs), false);
  assert.equal(editionAdopted([], recs), false);
});
