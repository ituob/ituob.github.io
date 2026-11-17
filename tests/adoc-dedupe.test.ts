import { test } from "node:test";
import assert from "node:assert/strict";
import { adocInline, adocToHtml } from "../src/lib/adoc.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "yaml";
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
  assert.equal(normalizeText("“Vojvoda”  Stepa – 5—9"), normalizeText('"Vojvoda" Stepa - 5-9'));
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
  assert.equal(dropped('Club "Banjica" 5-9 May', "Club \u201CBanjica\u201D  5\u20139 May"), true);
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

test("case differences are never merged", () => {
  assert.equal(dropped("Power 5 MW", "Power 5 mW"), false);
  assert.equal(dropped("Power 5 MW", "power 5 mw"), false);
  assert.equal(dropped("10 MHz", "10 MHZ"), false);
});

test("asset markup is not stripped one-sidedly", () => {
  assert.equal(dropped("area m^2^", "area m2"), false);
  assert.equal(dropped("x_1_ and y", "x1 and y"), false);
  assert.equal(dropped("H~2~O", "H2O"), false);
  // bold is presentation only (the real OB 1168 twin lacks the asset's bold)
  assert.equal(dropped("a *b* c", "a b c"), true);
  assert.equal(dropped("a _b_ c", "a b c"), false);
  assert.equal(dropped("file_name_x.txt", "filenamex.txt"), false);
});

test("the same markup on both sides still matches", () => {
  const marked = (text: string, mark: string) => ({
    type: "misc_communications",
    contents: { en: { type: "doc", content: [{ type: "paragraph", content: [
      { type: "text", text: "area m" }, { type: "text", marks: [{ type: mark }], text }] }] } },
  });
  assert.equal(dedupeAssetTwins([ref, marked("2", "superscript")], () => "area m^2^").length, 1);
  assert.equal(dedupeAssetTwins([ref, marked("2", "subscript")], () => "area m~2~").length, 1);
  const em = marked("2", "italic");
  (em.contents.en.content[0]!.content[0] as { text: string }).text = "area ";
  assert.equal(dedupeAssetTwins([ref, em], () => "area _2_").length, 1);
  assert.equal(dedupeAssetTwins([ref, marked("2", "superscript")], () => "area m~2~").length, 2);
});

test("intra-word underscores are not emphasis", () => {
  assert.equal(adocInline("file_name_x.txt"), "file_name_x.txt");
  assert.equal(adocInline("snake_case_word"), "snake_case_word");
  assert.equal(adocInline("a _b_ c"), "a <em>b</em> c");
});

test("other probe inputs render as AsciiDoc specifies", () => {
  assert.equal(adocInline("E=mc^2^"), "E=mc<sup>2</sup>");
  assert.equal(adocInline("a ~b~ c"), "a <sub>b</sub> c");
  assert.equal(adocInline("x^é^"), "x<sup>é</sup>");
  assert.equal(adocInline("2^^10^^"), "2<sup>10</sup>");
  assert.equal(adocInline("C:\\a~1\\b~2"), "C:\\a~1\\b~2");
  assert.equal(adocInline("http://x/~u/~v"), "http://x/~u/~v");
});

test("real OB 1167, 1168 and 1170 twins collapse to the asset reference", () => {
  const dir = join(dirname(new URL(import.meta.url).pathname), "fixtures/twins");
  for (const n of ["1167", "1168", "1170"]) {
    const refMsg = parse(readFileSync(join(dir, `${n}-ref.yaml`), "utf8"));
    const inline = parse(readFileSync(join(dir, `${n}-inline.yaml`), "utf8"));
    const adocText = readFileSync(join(dir, `${n}.adoc`), "utf8");
    assert.equal(refMsg.contents, "general/misc_comms.adoc");
    const out = dedupeAssetTwins([refMsg, inline], () => adocText);
    assert.deepEqual(out, [refMsg], `OB ${n}`);
    // changing a character in the inlined text keeps both
    const edited = JSON.parse(JSON.stringify(inline).replace("YU", "YV").replace("YT", "YV"));
    assert.equal(dedupeAssetTwins([refMsg, edited], () => adocText).length, 2, `OB ${n} edited`);
  }
});
