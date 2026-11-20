import assert from "node:assert/strict";
import { test } from "node:test";
import { filterEntries, type SearchEntry } from "../src/lib/search-filter.ts";

const entries: SearchEntry[] = [
  { kind: "issue", label: "OB No. 1350", href: "/issues/1350/", meta: "2025-01-01", boost: 90 },
  { kind: "recommendation", label: "ITU-T E.164", href: "/recommendations/e-164/", meta: "The international public telecommunication numbering plan" },
  { kind: "register", label: "E.118 IIN register", href: "/registers/e118-iin/", meta: "E.118" },
  { kind: "download", label: "E.164 (2010) PDF", href: "/downloads/#dl-E.164", meta: "PDF en" },
];

test("empty or whitespace query returns nothing", () => {
  assert.deepEqual(filterEntries(entries, ""), []);
  assert.deepEqual(filterEntries(entries, "   "), []);
});

test("matches label case-insensitively and returns hrefs of every hit", () => {
  const hrefs = filterEntries(entries, "e.164").map((e) => e.href);
  assert.deepEqual([...hrefs].sort(), ["/downloads/#dl-E.164", "/recommendations/e-164/"]);
  assert.ok(!hrefs.includes("/registers/e118-iin/"));
});

test("matches meta and requires every term", () => {
  assert.deepEqual(filterEntries(entries, "numbering plan").map((e) => e.label), ["ITU-T E.164"]);
  assert.deepEqual(filterEntries(entries, "numbering zzz"), []);
});

test("prefix match outranks mid-label match; boost breaks ties", () => {
  assert.equal(filterEntries(entries, "ob no")[0].href, "/issues/1350/");
  assert.equal(filterEntries(entries, "E.164")[0].label, "E.164 (2010) PDF");
});

test("no match yields an empty list", () => {
  assert.deepEqual(filterEntries(entries, "nonexistent"), []);
});
