import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";
import { extname } from "node:path";

// Resolve the extensionless TypeScript imports used by Astro under Node.
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier.startsWith(".") && !extname(specifier) ? `${specifier}.ts` : specifier, context);
  },
});
const { printedContext, loadPrintedContext, registerPrintedContext } = await import("../src/lib/printed-context.ts");
const { computeRunningAnnexes } = await import("../src/lib/loaders.ts");
const text = (node) => node.text ?? (node.content ?? []).map(text).join(" ");
const paragraph = (value) => ({ type: "paragraph", content: [{ type: "text", text: value }] });

test("keeps printed context without duplicating typed notes or copying source table data", () => {
  const nodes = [
    paragraph("Already represented note"),
    paragraph("A printed preamble outside the table"),
    paragraph("A printed preamble outside the table"),
    { type: "table", content: [
      { type: "table_row", content: [
        { type: "table_header", content: [paragraph("Applicant / Network")] },
        { type: "table_header", content: [paragraph("Assignment date")] },
      ] },
      { type: "table_row", content: [
        { type: "table_cell", content: [paragraph("Deprecated source-only row: Contact")] },
        { type: "table_cell", content: [paragraph("2000-01-01")] },
      ] },
    ] },
  ];
  const context = printedContext(nodes, { notes: ["Already represented note"] });
  assert.deepEqual(context.map(text), ["A printed preamble outside the table", "Applicant / Network", "Assignment date"]);
  assert.ok(context.every((node) => node.type !== "table"));
  assert.deepEqual(printedContext([], {}), []);
  assert.deepEqual(printedContext([{ type: "blockquote", content: [nodes[3]] }], {}), context.slice(1));
});

test("reads T.35 form labels and E.218 Applicant from the corpus", () => {
  const t35 = registerPrintedContext("t35-na").flatMap((group) => group.nodes).map(text).join(" ");
  assert.match(t35, /Name of Administration:/);
  assert.match(t35, /National manufacturers of H-, T- or V-Series/);
  const e218 = registerPrintedContext("e218-trcc").flatMap((group) => group.nodes).map(text).join(" ");
  assert.match(e218, /Applicant\s*\/\s*Network/);
});

test("reads the E.164 Note p preamble without hard-coding it in a page", () => {
  const notes = loadPrintedContext(1225, "e164-cc").map(text).join(" ");
  assert.match(notes, /Associated with shared country code 883/);
  assert.match(notes, /three-digit identification code/);
});

test("retains both additional E.212 definitions on OB 1296", () => {
  const notes = loadPrintedContext(1296, "e212-mnc").map(text).join(" ");
  assert.match(notes, /MSIN:.*Mobile Subscription Identification Number/);
  assert.match(notes, /numéro d.identification d.abonnement mobile/);
  assert.match(notes, /As defined in Annex E/);
  assert.match(notes, /base station established in Country B/);
  assert.doesNotMatch(notes, /iWay AG|Bouygues Telecom/);
  assert.deepEqual(loadPrintedContext(1296, "unknown-register"), []);
});

test("OB 1296 annex list uses the latest annex publication, including its date", () => {
  const annexes = computeRunningAnnexes(1296);
  const mnc = annexes.find((entry) => entry.pubId === "E212_MNC");
  assert.equal(mnc?.annexed_in, 1280);
  assert.match(String(mnc?.position_on), /2023/);
  const codes = annexes.find((entry) => entry.pubId === "E164_CC");
  assert.equal(codes?.annexed_in, 1114);
  assert.ok(annexes.every((entry) => entry.annexed_in <= 1296));
  const earlier = computeRunningAnnexes(1162).find((entry) => entry.pubId === "E212_MNC");
  assert.equal(earlier?.annexed_in, 1162);
  assert.match(String(earlier?.position_on), /2018/);
});
