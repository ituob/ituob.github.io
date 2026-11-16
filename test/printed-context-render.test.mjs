import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse } from "yaml";

// Run after npm run build; these assertions exercise the actual page hooks.
const dist = process.env.SITE_DIST ?? fileURLToPath(new URL("../dist/", import.meta.url));
const page = (path) => readFileSync(join(dist, path, "index.html"), "utf8");
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

for (const [slug, expected] of [
  ["t35-na", /Name of Administration:/],
  ["e218-trcc", /Applicant\s*\/\s*Network/],
  ["e164-cc", /Associated with shared country code 883, the following three-digit identification/],
]) {
  test(`${slug} prints its omitted label or preamble`, () => {
    assert.ok(expected.test(text(page(`registers/${slug}`))), `Missing printed context on ${slug}`);
  });
}

test("issue 1296 prints both E.212 definitions and preserves the typed entry once", () => {
  const html = page("issues/1296");
  assert.ok(/MSIN:.*Mobile Subscription Identification Number/.test(text(html)), "MSIN definition is printed");
  assert.ok(/As defined in Annex E.*base station established in Country B/.test(text(html)), "Extra-territorial definition is printed");
  assert.equal(html.match(/iWay AG/g)?.length, 1);
  assert.match(text(html), /228 73/);
});


for (const [id, metadataIncomplete, incomplete] of [[669, true, true], [955, false, false], [1075, true, false], [1125, false, false], [1296, false, false], [1343, false, false]]) {
  test(`issue ${id} preview banner agrees with the real completeness data`, () => {
    const dataRoot = process.env.PARITY_OB_DATA_ROOT ?? fileURLToPath(new URL("../data-ob/", import.meta.url));
    const meta = parse(readFileSync(join(dataRoot, "ob-issues", String(id), "meta.yaml"), "utf8"));
    assert.equal(meta.incomplete === true, metadataIncomplete, "source metadata marker");
    const html = page(`issues/${id}`);
    assert.equal(html.includes("incomplete-banner"), incomplete, "rendered banner");
    assert.equal(/data below may not be complete yet/.test(text(html)), incomplete, "rendered notice");
  });
}

test("register source context is explicitly historical", () => {
  assert.match(text(page("registers/e164-cc")), /Historical printed amendment labels and notes/);
});
