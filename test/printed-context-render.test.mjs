import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

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

test("issue 1296 lists the latest annex bulletin numbers", () => {
  const annexes = page("issues/1296").match(/<article class="message message--running_annexes">([\s\S]*?)<\/article>/)?.[1];
  assert.ok(annexes, "running annexes section exists");
  for (const number of [1280, 1114, 1125]) {
    assert.ok(annexes.includes(`href="/issues/${number}/"`), `Annex OB ${number} is listed`);
  }
});

test("issue 669 prints its incomplete-data notice", () => {
  assert.ok(/data below may not be complete yet/.test(text(page("issues/669"))), "Incomplete edition notice is printed");
});
