import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classify, REGISTER_SLUGS } from "./corpus.ts";
import { description } from "./description.ts";
import { firstDifference } from "./exact.ts";
import {
  appendItem, blankState, classesIn, clearField, removeItem, setField, toFormState, toInstance, updateAt, validate, widgetFor,
  type Diagnostic, type FormNode, type ListNode, type ObjectNode,
} from "./model.ts";
import { parseYaml, stringifyYaml, YamlTimestamp } from "./yaml-io.ts";

const here = dirname(fileURLToPath(import.meta.url));
const dataRoot = process.env["OB_DATA_ROOT"] ?? join(here, "../../../data-ob");
const corpusRoot = join(dataRoot, "ob-issues");

const roundTrip = (cls: string, text: string) => {
  const stored = parseYaml(text);
  const { state, diagnostics } = toFormState(cls, stored);
  const out = toInstance(state);
  return { stored, state, diagnostics, out, diff: firstDifference(stored, out) };
};

describe("yaml-io keeps stored values exact", () => {
  const text = `a: 2012-01-31 23:00:00.000000000 Z
b: 2012-03-15T00:00:00.000Z
c: 2012-03-01
d: '2015'
e: 'yes'
f: ~
g:
h: {en: ''}
i: 'G.168 '
languages: {en: true}
`;
  it("reads timestamps as timestamps, strings as strings, null as null", () => {
    const v = parseYaml(text) as Record<string, unknown>;
    expect(v["a"]).toEqual(new YamlTimestamp("2012-01-31 23:00:00.000000000 Z"));
    expect(v["d"]).toBe("2015");
    expect(v["e"]).toBe("yes");
    expect(v["f"]).toBeNull();
    expect(v["h"]).toEqual({ en: "" });
    expect(v["languages"]).toEqual({ en: true });
  });
  it("writes back what Ruby reads as the same values (a datetime is not collapsed to a date)", () => {
    const v = parseYaml(text);
    const written = stringifyYaml(v);
    expect(written).toContain("b: 2012-03-15T00:00:00.000Z");
    expect(written).toContain("a: 2012-01-31 23:00:00.000000000 Z");
    expect(written).toMatch(/d: "2015"/);
    expect(firstDifference(v, parseYaml(written))).toBeNull();
  });
});

describe("class description", () => {
  it("is the ontology: required and collection facts are present, ts-types alone lack them", () => {
    const rc = description.classes["RegisterChange"]!;
    expect(rc.attributes.find((a) => a.name === "identifier")).toMatchObject({ required: true, kind: "class", collection: false });
    expect(rc.attributes.find((a) => a.name === "register_id")?.wire).toBe("register");
    expect(description.classes["Amendment"]!.attributes.find((a) => a.name === "notes")?.collection).toBe(true);
    expect(description.classes["NNPAmendment"]!.attributes.find((a) => a.name === "_class")?.default).toBe("NNPAmendment");
    expect(description.enums["ActionType"]).toEqual(["ADD", "SUP", "REP", "LIR", "MOD", "DEL", "SEED"]);
  });
  it("derives a widget per attribute", () => {
    const attr = (c: string, n: string) => description.classes[c]!.attributes.find((a) => a.name === n)!;
    expect(widgetFor(attr("IssueMetadata", "id"))).toBe("integer");
    expect(widgetFor(attr("IssueMetadata", "publication_date"))).toBe("date");
    expect(widgetFor(attr("IssueMetadata", "languages"))).toBe("json");
    expect(widgetFor(attr("IssueMetadata", "authors"))).toBe("list");
    expect(widgetFor(attr("IssueAuthor", "recommended"))).toBe("boolean");
    expect(widgetFor(attr("RegisterChange", "type"))).toBe("select");
    expect(widgetFor(attr("RegisterChange", "identifier"))).toBe("object");
  });
});

describe("exactness on the values that used to be lost", () => {
  it("IssueMetadata: languages map, timestamp, id integer, explicit nulls", () => {
    const r = roundTrip("IssueMetadata", "id: 1000\npublication_date: 2012-03-15T00:00:00.000Z\ncutoff_date: 2012-03-03\nissn: 1564-5223\nlanguages:\n  en: true\nincomplete:\n");
    expect(r.diff).toBeNull();
    expect(r.diagnostics).toEqual([]);
    expect((r.out as Record<string, unknown>)["incomplete"]).toBeNull();
  });
  it("ApprovedRecommendations: a payload map and a stored '2015' stay as stored", () => {
    const r = roundTrip("GeneralApprovedRecommendations", "type: approved_recommendations\npayload:\n  items:\n    'G.168 ': 2012-01-31 23:00:00.000000000 Z\n    G.993.2: '2015'\n");
    expect(r.diff).toBeNull();
  });
  it("a map stored where the ontology says list is kept and reported, not coerced", () => {
    const r = roundTrip("GeneralApprovedRecommendations", "type: approved_recommendations\nitems:\n  G.168: x\n");
    expect(r.diff).toBeNull();
    expect(r.diagnostics.map((d) => d.code)).toContain("shape");
  });
  it("unknown keys survive in their stored position", () => {
    const r = roundTrip("GeneralCustom", "type: custom\nmystery: 1\ntitle:\n  en: ''\ncontents: {}\n");
    expect(r.diff).toBeNull();
    expect(r.diagnostics.map((d) => d.code)).toContain("unknown-key");
  });
});

describe("edits", () => {
  const issue = () => toFormState("IssueMetadata", parseYaml("id: 7\nissn: 1564-5223\nauthors:\n- name: TSB\n  contacts:\n  - type: email\n    data: a@b\n")).state;
  it("changes only the edited value", () => {
    const before = toInstance(issue()) as Record<string, unknown>;
    const after = toInstance(setField(issue(), "issn", "0000-0000")) as Record<string, unknown>;
    expect(after).toEqual({ ...before, issn: "0000-0000" });
    expect(Object.keys(after)).toEqual(Object.keys(before));
  });
  it("places a newly set attribute in ontology order, and clearing removes the key", () => {
    const withCutoff = setField(issue(), "cutoff_date", new YamlTimestamp("2012-03-03"));
    expect(Object.keys(toInstance(withCutoff) as object)).toEqual(["id", "cutoff_date", "issn", "authors"]);
    expect(Object.keys(toInstance(clearField(withCutoff, "cutoff_date")) as object)).toEqual(["id", "issn", "authors"]);
  });
  it("adds and removes list items and edits nested nodes by path", () => {
    let root: FormNode = issue();
    root = updateAt(root, ["authors"], (n) => appendItem(n as ListNode, { name: "ITU", contacts: [] }));
    root = updateAt(root, ["authors", 0, "contacts", 0], (n) => setField(n as ObjectNode, "data", "x@y"));
    const out = toInstance(root) as { authors: { name: string; contacts: { data: string }[] }[] };
    expect(out.authors.map((a) => a.name)).toEqual(["TSB", "ITU"]);
    expect(out.authors[0]!.contacts[0]!.data).toBe("x@y");
    root = updateAt(root, ["authors"], (n) => removeItem(n as ListNode, 0));
    expect((toInstance(root) as { authors: unknown[] }).authors).toHaveLength(1);
  });
  it("a blank register change carries its defaults and reports the required identifier", () => {
    const blank = blankState("RegisterChange");
    expect(validate(blank).map((d: Diagnostic) => d.code)).toEqual(["required"]);
    const nnp = blankState("NNPAmendment");
    expect(toInstance(nnp)).toEqual({ _class: "NNPAmendment" });
  });
});

// ---- corpus -------------------------------------------------------------------

function walk(dir: string): string[] {
  return readdirSync(dir).sort().flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".yaml") ? [p] : [];
  });
}

/** One group per owning position (meta, each register slug, each message dir, each text.yaml dir). */
function groupOf(rel: string): string {
  const parts = rel.split("/").slice(1);
  const name = parts.at(-1) ?? "";
  return name === "text.yaml" ? `text:${parts[0]}` : parts.length === 1 ? name : parts.slice(0, -1).join("/");
}

/**
 * Deterministic stratified sample: per group, the first and last issue, the
 * largest file and evenly spaced picks up to SAMPLE_PER_GROUP. FORM_FULL=1 runs all files.
 */
const SAMPLE_PER_GROUP = 12;
function sample(paths: string[]): string[] {
  const groups = new Map<string, string[]>();
  for (const p of paths) {
    const g = groupOf(relative(corpusRoot, p));
    groups.set(g, [...(groups.get(g) ?? []), p]);
  }
  const picked = new Set<string>();
  for (const list of groups.values()) {
    const step = Math.max(1, (list.length - 1) / (SAMPLE_PER_GROUP - 1));
    for (let i = 0; i < SAMPLE_PER_GROUP && Math.round(i * step) < list.length; i++) picked.add(list[Math.round(i * step)]!);
    picked.add(list[list.length - 1]!);
    picked.add(list.reduce((a, b) => (statSync(b).size > statSync(a).size ? b : a)));
  }
  return paths.filter((p) => picked.has(p));
}

interface Row { rel: string; root: string; classes: string[]; diagnostics: Diagnostic[]; diff: string | null; textDiff: string | null; requiredMissing: number }

describe("corpus round trip (stored -> form state -> serialized == stored)", () => {
  it(`finds the corpus at ${corpusRoot} (set OB_DATA_ROOT; a missing corpus is a failure, never a skip)`, () => {
    expect(existsSync(corpusRoot)).toBe(true);
  });

  const rows: Row[] = [];
  let skipped = 0;
  let total = 0;
  const full = process.env["FORM_FULL"] === "1";
  const all = existsSync(corpusRoot) ? walk(corpusRoot) : [];
  const files = full ? all : sample(all);
  it(`is identical for every form-driven file of the ${full ? "FULL corpus" : "stratified sample"}`, () => {
    total = all.length;
    for (const path of files) {
      const rel = relative(corpusRoot, path).split("/").slice(1).join("/");
      const issue = relative(corpusRoot, path).split("/")[0];
      const text = readFileSync(path, "utf8");
      const stored = parseYaml(text);
      const c = classify(rel, stored);
      if (!c) { skipped++; continue; }
      const { state, diagnostics } = toFormState(c.className, stored);
      const out = toInstance(state);
      const diff = firstDifference(stored, out);
      const textDiff = firstDifference(stored, parseYaml(stringifyYaml(out)));
      rows.push({ rel: `${issue}/${rel}`, root: state.className, classes: [...classesIn(state)], diagnostics, diff, textDiff, requiredMissing: validate(state).length });
    }
    const bad = rows.filter((r) => r.diff || r.textDiff);
    expect(bad.map((r) => `${r.rel}: ${r.diff ?? r.textDiff}`).slice(0, 10)).toEqual([]);
  });

  it("covers every submittable register class, every General* class in the corpus and IssueMetadata", () => {
    const filesByClass = new Map<string, number>();
    for (const r of rows) for (const c of r.classes) filesByClass.set(c, (filesByClass.get(c) ?? 0) + 1);
    const amendmentClasses = Object.keys(description.classes).filter((c) => c.endsWith("Amendment") && c !== "Amendment" && c !== "OldIssue");
    const submittable = [...REGISTER_SLUGS.map((s) => slugClass[s]), "TextAmendment", "RegisterChange"];
    for (const c of submittable) expect(filesByClass.get(c) ?? 0, `${c} files`).toBeGreaterThan(0);
    for (const c of ["IssueMetadata", "IssueAuthor", "IssueContact", "GeneralApprovedRecommendations", "GeneralCallbackProcedures", "GeneralCustom", "GeneralIpns", "GeneralIptn", "GeneralMid", "GeneralMiscCommunications", "GeneralOrgChanges", "GeneralRunningAnnexes", "GeneralServiceRestrictions", "GeneralSancs", "GeneralTelephoneService"]) {
      expect(filesByClass.get(c) ?? 0, `${c} files`).toBeGreaterThan(0);
    }
    expect(amendmentClasses.length).toBeGreaterThan(15);

    const byCode: Record<string, number> = {};
    const diagByClass: Record<string, Record<string, number>> = {};
    for (const r of rows) {
      for (const d of r.diagnostics) {
        byCode[d.code] = (byCode[d.code] ?? 0) + 1;
        const k = `${r.root}`;
        diagByClass[k] ??= {};
        diagByClass[k][d.code] = (diagByClass[k][d.code] ?? 0) + 1;
      }
    }
    const report = {
      corpusRoot, mode: full ? "full" : "sample", filesWalked: total, filesRun: files.length, filesFormDriven: rows.length, filesSkippedFreeform: skipped,
      identicalValue: rows.filter((r) => !r.diff).length, identicalAfterYamlWrite: rows.filter((r) => !r.textDiff).length,
      filesWithDiagnostics: rows.filter((r) => r.diagnostics.length).length, diagnosticsByCode: byCode, diagnosticsByRootClass: diagByClass,
      requiredMissingFiles: rows.filter((r) => r.requiredMissing).length,
      classFileCounts: Object.fromEntries([...filesByClass].sort()),
      rootClassFileCounts: rows.reduce<Record<string, number>>((m, r) => ((m[r.root] = (m[r.root] ?? 0) + 1), m), {}),
      classesWithNoCorpusFile: Object.keys(description.classes).filter((c) => !filesByClass.has(c)).sort(),
      diagnosticSamples: Object.fromEntries(Object.keys(byCode).map((code) => [code, rows.flatMap((r) => r.diagnostics.filter((d) => d.code === code).slice(0, 1).map((d) => `${r.rel} ${d.path}: ${d.message}`)).slice(0, 6)])),
    };
    if (process.env["FORM_REPORT"]) writeFileSync(process.env["FORM_REPORT"], JSON.stringify(report, null, 2));
    expect(report.identicalValue).toBe(rows.length);
    expect(report.identicalAfterYamlWrite).toBe(rows.length);
  });
});

const slugClass: Record<(typeof REGISTER_SLUGS)[number], string> = {
  dp: "DPAmendment", "e118-iin": "E118Amendment", "e164-acn": "E164ACNAmendment", "e164-cc": "E164CCAmendment",
  "e212-mnc": "E212MNCAmendment", "e218-trcc": "E218TRCCAmendment", "f32-tdi": "F32TDIAmendment", "f400-admd": "F400Amendment",
  "list-viii": "ListVIIIAmendment", "m1400-icc": "M1400Amendment", nnp: "NNPAmendment", "q708-ispc": "Q708ISPCAmendment",
  "q708-sanc": "Q708SANCAmendment", "t35-na": "T35NAAmendment", "x121-dnic": "X121DNICAmendment",
};
