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

test("normalizeText unifies quotes, dashes, whitespace, case; keeps digits and punctuation", () => {
  assert.equal(normalizeText("“Vojvoda”  Stepa – 5—9"), normalizeText('"vojvoda" stepa - 5-9'));
  assert.notEqual(normalizeText("3.5 MHz"), normalizeText("35 MHz"));
});

const dropped = (a: string, i: string) => {
  const inl = {
    type: "misc_communications",
    contents: { en: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: i }] }] } },
  };
  return dedupeAssetTwins([ref, inl], () => a).length === 1;
};

test("different numbers, spacing, punctuation and marks are never merged", () => {
  assert.equal(dropped("3.5 MHz", "35 MHz"), false);
  assert.equal(dropped("from 5-9 May", "from 59 May"), false);
  assert.equal(dropped("YU125VS", "YU12 5VS"), false);
  assert.equal(dropped("+41 22 730 5111", "+412 27305111"), false);
  assert.equal(dropped("Rs 1,000", "Rs 1.000"), false);
  assert.equal(dropped("AB-C", "ABC"), false);
  assert.equal(dropped("क्या", "कया"), false);
  assert.equal(dropped("كَتَبَ", "كتب"), false);
  assert.equal(dropped("café", "cafe"), false);
  assert.equal(dropped("a b", "a"), false);
});

test("quote, dash, whitespace, case and composition differences still match", () => {
  assert.equal(dropped('Club "Banjica" 5-9 May', "Club “Banjica”  5–9 may"), true);
  assert.equal(dropped("café", "café"), true);
});

test("heading and trailing-colon structure is ignored", () => {
  const para = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
  const inl = {
    type: "misc_communications",
    contents: { en: { type: "doc", content: [para("Serbia"), para("Communication of 1.II.2019:"), para("Text here.")] } },
  };
  const a = "==== Serbia\n\n===== Communication of 1.II.2019\n\nText\nhere.\n";
  assert.equal(dedupeAssetTwins([ref, inl], () => a).length, 1);
});

test("an inlined message with an extra field is not dropped", () => {
  const inl = { ...pm("YT74DP"), title: "x" };
  assert.deepEqual(dedupeAssetTwins([ref, inl], loader), [ref, inl]);
});

test("superscript and subscript leave non-markup text untouched", () => {
  for (const t of ["x^2+y^2", "10^6-10^9", "(~5,~10)", "http://x.org/~user/a~b", "~~x~~", "a ^ b ^ c"]) {
    assert.equal(adocInline(t), t);
  }
});

test("constrained and embedded forms render", () => {
  assert.equal(adocInline("125^th^"), "125<sup>th</sup>");
  assert.equal(adocInline("73^rd^"), "73<sup>rd</sup>");
  assert.equal(adocInline("H~2~O"), "H<sub>2</sub>O");
});
