import { test } from "node:test";
import assert from "node:assert/strict";
import { adocInline, adocToHtml } from "../src/lib/adoc.ts";
import { dedupeAssetTwins, normalizeText } from "../src/lib/dedupe.ts";

test("single-caret superscript and tilde subscript render", () => {
  assert.equal(adocInline("the 125^th^ year"), "the 125<sup>th</sup> year");
  assert.equal(adocInline("73^rd^ and 10^th^"), "73<sup>rd</sup> and 10<sup>th</sup>");
  assert.equal(adocInline("H~2~O"), "H<sub>2</sub>O");
});

test("double-caret superscript still works", () => {
  assert.equal(adocInline("x^^2^^"), "x<sup>2</sup>");
});

test("a lone caret or caret around spaces stays literal", () => {
  assert.equal(adocInline("a ^ b ^ c"), "a ^ b ^ c");
  assert.equal(adocInline("5^"), "5^");
  assert.equal(adocInline("a ~ b ~ c"), "a ~ b ~ c");
});

test("markup is escaped before superscript is applied", () => {
  assert.equal(adocInline("<b>1^st^</b>"), "&lt;b&gt;1<sup>st</sup>&lt;/b&gt;");
});

test("adocToHtml: headings, paragraph with superscript and strong", () => {
  const html = adocToHtml("==== Serbia\n\nThe 74^th^ call *YT74DP*.\n");
  assert.equal(html, "<h5>Serbia</h5>\n<p>The 74<sup>th</sup> call <strong>YT74DP</strong>.</p>");
});

const adoc = `==== Serbia

===== Communication of 21.III.2019:

On the occasion of the 74^th^ anniversary, use *YT74DP* from "5" to 9 May.
`;
const pm = (text: string) => ({
  type: "misc_communications",
  contents: {
    en: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Serbia" }] },
        { type: "paragraph", content: [{ type: "text", text: "Communication of 21.III.2019:" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "On the occasion of the 74" },
            { type: "text", marks: [{ type: "superscript" }], text: "th" },
            { type: "text", text: " anniversary, use " },
            { type: "text", marks: [{ type: "strong" }], text: text },
            { type: "text", text: " from “5” to 9 May." },
          ],
        },
      ],
    },
  },
});
const ref = { type: "misc_communications", contents: "general/misc_comms.adoc" };
const loader = (m: { contents?: unknown }) => (typeof m.contents === "string" ? adoc : null);

test("asset reference and identical inlined twin collapse to the asset reference", () => {
  const out = dedupeAssetTwins([ref, pm("YT74DP")], loader);
  assert.deepEqual(out, [ref]);
});

test("order of the pair does not matter", () => {
  assert.deepEqual(dedupeAssetTwins([pm("YT74DP"), ref], loader), [ref]);
});

test("an inlined message with different text is kept", () => {
  const other = pm("YT99XX");
  assert.deepEqual(dedupeAssetTwins([ref, other], loader), [ref, other]);
});

test("same text under a different message type is kept", () => {
  const other = { ...pm("YT74DP"), type: "custom" };
  assert.deepEqual(dedupeAssetTwins([ref, other], loader), [ref, other]);
});

test("an unreadable asset cannot prove a duplicate", () => {
  const msgs = [ref, pm("YT74DP")];
  assert.deepEqual(dedupeAssetTwins(msgs, () => null), msgs);
});

test("messages without an asset reference are untouched", () => {
  const msgs = [pm("YT74DP"), pm("YT74DP")];
  assert.deepEqual(dedupeAssetTwins(msgs, loader), msgs);
});

test("normalizeText ignores quotes, colons, case and whitespace", () => {
  assert.equal(normalizeText("“Vojvoda”  Stepa:"), normalizeText('"vojvoda" stepa'));
});
