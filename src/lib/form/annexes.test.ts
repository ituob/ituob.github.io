import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  annexPublication, isPositionDate, pickerCandidates, publicationIdError, removeAnnex, runningAnnexes, setAnnexPosition,
  validateAnnexes, type AnnexIndexEntry,
} from "./annexes.ts";
import { classify } from "./corpus.ts";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (n: number) => readFileSync(join(here, `../../../test/fixtures/annexes/${n}.yaml`), "utf8");

describe("annex validator", () => {
  it("accepts {} , null entries, dates and timestamps", () => {
    expect(validateAnnexes({})).toEqual([]);
    expect(validateAnnexes({ A: null, B: { position_on: "2016-10-01" }, C: { position_on: "2012-03-15T00:00:00.000Z" }, D: {} })).toEqual([]);
  });
  it.each(["2026-02-30", "2026-13-01", "15/03/2012", "", "2012-03-15T24:00:00Z", "2012-3-5"])("rejects the date %j", (d) => {
    expect(isPositionDate(d)).toBe(false);
    expect(validateAnnexes({ A: { position_on: d } }).map((e) => e.path)).toContain("A.position_on");
  });
  it.each<[string, unknown]>([
    ["position_on", null], ["position_on", 20261001], ["position_on", {}],
    ["datasets", null], ["datasets", "data"], ["datasets", true],
    ["datasets", { value: undefined }], ["datasets", { value: Infinity }],
  ])("rejects invalid %s field value %j without ontology validation", (field, value) => {
    expect(validateAnnexes({ SR: { [field]: value } })).toEqual([
      expect.objectContaining({ path: `SR.${field}`, code: "type" }),
    ]);
  });
  it("rejects non-mapping roots, scalar entries, unknown keys and bad ids", () => {
    expect(validateAnnexes([]).length).toBe(1);
    expect(validateAnnexes(null).length).toBe(1);
    expect(validateAnnexes({ A: 3 })[0]?.code).toBe("type");
    expect(validateAnnexes({ A: { x: 1 } })[0]?.code).toBe("unknown");
    expect(validateAnnexes({ A: { datasets: [] } })[0]?.path).toBe("A.datasets");
    expect(publicationIdError(" A")).not.toBeNull();
    expect(publicationIdError("")).not.toBeNull();
    expect(publicationIdError("Legal time 2012")).toBeNull();
  });
});

describe("running annexes and picker", () => {
  const index: AnnexIndexEntry[] = [
    { issue: 1000, publication_id: "SR", position_on: "2012-03-15" },
    { issue: 1109, publication_id: "Q708_ISPC", position_on: "2016-10-01" },
    { issue: 1200, publication_id: "SR", position_on: null },
    { issue: 1400, publication_id: "FUTURE", position_on: "2030-01-01" },
    { issue: 900, publication_id: "OLD", position_on: null },
  ];
  it("lists running annexes before the issue, newest issue first, excluding the issue itself and later ones", () => {
    const r = runningAnnexes(index, 1400);
    expect(r.map((c) => c.id)).toEqual(["SR", "Q708_ISPC", "OLD"]);
    expect(r.find((c) => c.id === "SR")).toMatchObject({ annexed_to: 1200, position_on: "2012-03-15" });
    expect(r.every((c) => c.running)).toBe(true);
  });
  it("puts running annexes first in the picker and appends other known ids", () => {
    const c = pickerCandidates(index, 1150);
    expect(c.map((x) => [x.id, x.running])).toEqual([["Q708_ISPC", true], ["SR", true], ["OLD", true], ["FUTURE", false]]);
    expect(pickerCandidates(index, 1150, "q70").map((x) => x.id)).toEqual(["Q708_ISPC"]);
  });
  it("annexing defaults to the running position and never replaces an existing annex", () => {
    const run = runningAnnexes(index, 1400);
    expect(annexPublication({}, "SR", run)).toEqual({ SR: { position_on: "2012-03-15" } });
    expect(annexPublication({}, "NEW", run)).toEqual({ NEW: null });
    const w = { SR: { position_on: "2020-01-01" } };
    expect(annexPublication(w, "SR", run)).toBe(w);
    expect(removeAnnex({ A: null, B: null }, "A")).toEqual({ B: null });
  });
});

describe("annex position editing keeps datasets (OB 1162)", () => {
  const wire = parseYaml(fixture(1162)) as Record<string, any>;
  const id = Object.keys(wire).find((k) => wire[k]?.datasets)!;
  it("has a dataset entry in the real corpus file", () => expect(id).toBeTruthy());
  it("changing the date keeps datasets byte-for-byte; clearing keeps them too", () => {
    const changed = setAnnexPosition(wire, id, "2020-05-06");
    expect(changed[id]?.position_on).toBe("2020-05-06" + wire[id].position_on.slice(10));
    expect(changed[id]?.datasets).toEqual(wire[id].datasets);
    const cleared = setAnnexPosition(wire, id, "");
    expect(cleared[id]?.position_on).toBeUndefined();
    expect(cleared[id]?.datasets).toEqual(wire[id].datasets);
  });
  it("clearing a date-only entry becomes null", () => {
    expect(setAnnexPosition({ A: { position_on: "2016-10-01" } }, "A", "")).toEqual({ A: null });
  });
  it("validates and survives a YAML write/parse", () => {
    expect(validateAnnexes(wire)).toEqual([]);
    expect(parseYaml(stringifyYaml(wire))).toEqual(wire);
  });
});

describe("annexes in the corpus", () => {
  it("classifies annexes.yaml with the annexes role", () => {
    expect(classify("annexes.yaml", {})).toEqual({ className: "IssueAnnexes", role: "annexes" });
  });
  const dataRoot = process.env["OB_DATA_ROOT"] ?? join(here, "../../../data-ob");
  const root = join(dataRoot, "ob-issues");
  it("every annexes.yaml in the corpus validates (OB_DATA_ROOT; a missing corpus is a failure)", () => {
    expect(existsSync(root)).toBe(true);
    const bad: string[] = [];
    let n = 0;
    for (const dir of readdirSync(root)) {
      const f = join(root, dir, "annexes.yaml");
      if (!existsSync(f)) continue;
      n++;
      const v = parseYaml(readFileSync(f, "utf8"));
      const issues = validateAnnexes(v ?? {});
      if (issues.length) bad.push(`${dir}: ${issues[0]?.message}`);
    }
    expect(n).toBeGreaterThan(200);
    expect(bad.slice(0, 10)).toEqual([]);
  });
});

describe("breaker regressions", () => {
  it("accepts every publication id in both publication catalogs", () => {
    const dataRoot = process.env["OB_DATA_ROOT"] ?? join(here, "../../../data-ob");
    for (const [file, collection, field] of [["registers", "registers", "register_id"], ["publications", "publications", "publication_id"]]) {
      const catalog = parseYaml(readFileSync(join(dataRoot, "catalogs", `${file}.yaml`), "utf8"));
      for (const entry of catalog[collection!]) expect(publicationIdError(entry[field!])).toBeNull();
    }
  });
  it.each(["yes", "no", "on", "off", "2016-10-01", "<<", "1_000", "0b1", "1:30"])("rejects non-publication YAML 1.1 key %j", id => {
    expect(validateAnnexes({ [id]: null })).not.toEqual([]);
  });
  it.each(["\u0000", "\u001f", "\u007f", "\u0080", "\u0085", "\u009f", "\u2028", "\u2029", "\ufeff", "\ud800", "\udfff"])("rejects unsafe Unicode in publication ids %j", ch => {
    expect(publicationIdError(`SR${ch}A`)).not.toBeNull();
  });
  it("preserves the full Time suffix when editing or re-entering its day", () => {
    const wire = { SR: { position_on: "2016-10-01T12:34:56.123Z", datasets: { x: 1 } }, DP: { position_on: "2016-10-01" } };
    expect(setAnnexPosition(wire, "SR", "2016-10-01")).toEqual(wire);
    expect(setAnnexPosition(wire, "SR", "2020-05-06")).toEqual({ ...wire, SR: { ...wire.SR, position_on: "2020-05-06T12:34:56.123Z" } });
    expect(setAnnexPosition(wire, "DP", "2020-05-06").DP?.position_on).toBe("2020-05-06");
  });
  it("rejects deeply nested datasets without recursion or throwing", () => {
    let datasets: Record<string, unknown> = {};
    for (let i = 0; i < 20000; i++) datasets = { n: datasets };
    expect(validateAnnexes({ SR: { datasets } })).toEqual(expect.arrayContaining([expect.objectContaining({ path: "SR.datasets", code: "type" })]));
  });
  it("accepts datasets at the depth boundary and rejects the next level", () => {
    let datasets: Record<string, unknown> = {};
    for (let i = 0; i < 32; i++) datasets = { n: datasets };
    expect(validateAnnexes({ SR: { datasets } })).toEqual([]);
    expect(validateAnnexes({ SR: { datasets: { n: datasets } } })[0]?.path).toBe("SR.datasets");
  });
  it("bounds dataset size for wide objects and large strings", () => {
    for (const datasets of [{ x: "x".repeat(200001) }, Object.fromEntries(Array.from({ length: 10001 }, (_, i) => [`k${i}`, 1]))]) {
      expect(validateAnnexes({ SR: { datasets } })).toEqual(expect.arrayContaining([expect.objectContaining({ path: "SR.datasets", code: "type" })]));
    }
  });
});
