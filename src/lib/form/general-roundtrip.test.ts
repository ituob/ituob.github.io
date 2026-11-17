import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateGeneralMessage } from "../../../worker/lib/general-messages.ts";
import { generalBinding } from "./general.ts";
import { setField, toFormState, toInstance } from "./model.ts";
import { parseYaml, stringifyYamlPreservingSource, stringifyYaml, YamlTimestamp } from "./yaml-io.ts";

const jsonBridge = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const corpusRoot = join(process.env["OB_DATA_ROOT"] ?? join(dirname(fileURLToPath(import.meta.url)), "../../../data-ob"), "ob-issues");

describe("source-preserving YAML serialization", () => {
  const source = "---\r\n# Authored formatting\r\ntype: custom\r\ncontents: &notice {en: 'Original'}\r\ntitle: *notice\r\npublication_date: 2012-01-31 23:00:00.000000000 Z\r\n";

  it("preserves bytes through form state and the HTTP JSON bridge", () => {
    expect(stringifyYamlPreservingSource(parseYaml(source), source)).toBe(source);
    const state = toFormState("GeneralCustom", jsonBridge(parseYaml(source))).state;
    expect(stringifyYamlPreservingSource(toInstance(state), source)).toBe(source);
    expect(stringifyYaml(toInstance(state))).not.toBe(source);
  });

  it("serializes an actual edit and restores the original bytes after reverting it", () => {
    const original = jsonBridge(parseYaml(source)) as Record<string, unknown>;
    const state = toFormState("GeneralCustom", original).state;
    const changed = setField(state, "contents", { en: "Revised notice" });
    const saved = stringifyYamlPreservingSource(toInstance(changed), source);
    expect(saved).not.toBe(source);
    expect(jsonBridge(parseYaml(saved))).toEqual({ ...original, contents: { en: "Revised notice" } });
    expect((parseYaml(saved) as Record<string, unknown>).publication_date).toEqual(new YamlTimestamp("2012-01-31 23:00:00.000000000 Z"));
    expect(stringifyYamlPreservingSource(toInstance(setField(changed, "contents", original.contents)), source)).toBe(source);
  });

  it.each([
    ["value: '1'\n", { value: 1 }],
    ["value: null\n", {}],
    ["value: null\n", { value: undefined }],
    ["value: [one, two]\n", { value: ["two", "one"] }],
    ["a: 1\nb: 2\n", { b: 2, a: 1 }],
  ])("does not reuse source after changing types, presence or order: %s", (source, value) => {
    expect(stringifyYamlPreservingSource(value, source)).not.toBe(source);
  });

  it("writes new drafts without requiring source YAML", () => {
    const value = { type: "custom", contents: "New notice" };
    expect(parseYaml(stringifyYamlPreservingSource(value))).toEqual(value);
    expect(parseYaml(stringifyYamlPreservingSource(value, null))).toEqual(value);
  });

  it("preserves YAML 1.1 scalars after the JSON transport normalizes them", () => {
    const source = "quoted: 'yes'\nboolean: yes\nnumber: 1:30\nnan: .NaN\ninfinity: .inf\nnegative_zero: -0.0\n";
    const value = jsonBridge(parseYaml(source)) as Record<string, unknown>;
    expect(value).toEqual({ quoted: "yes", boolean: true, number: 90, nan: null, infinity: null, negative_zero: 0 });
    expect(stringifyYamlPreservingSource(value, source)).toBe(source);
    const edited = { ...value, quoted: "no", nan: 1 };
    const saved = parseYaml(stringifyYamlPreservingSource(edited, source)) as Record<string, unknown>;
    expect(jsonBridge(saved)).toEqual(edited);
    expect(saved.infinity).toBe(Infinity);
    expect(saved.nan).toBe(1);
    const unrelatedEdit = parseYaml(stringifyYamlPreservingSource({ ...value, quoted: "no" }, source)) as Record<string, unknown>;
    expect(unrelatedEdit.nan).toBeNaN();
  });
});

describe("general message corpus: YAML -> HTTP JSON -> schema form -> saved YAML", () => {
  // Exact corpus coverage, including the legacy telephone type with no records.
  const counts = { sanc: 124, telephone_service: 0, telephone_service_2: 377, mid: 6, custom: 105 } as const;

  it("requires the real corpus (a missing checkout is a failure)", () => {
    expect(existsSync(corpusRoot), corpusRoot).toBe(true);
  });

  it.each(Object.entries(counts))("preserves every %s record byte-for-byte (%i records)", (type, expectedCount) => {
    const paths = existsSync(corpusRoot) ? readdirSync(corpusRoot, { withFileTypes: true })
      .filter(issue => issue.isDirectory())
      .flatMap(issue => {
        const directory = join(corpusRoot, issue.name, type);
        return existsSync(directory) ? readdirSync(directory)
          .filter(name => name.endsWith(".yaml"))
          .map(name => join(directory, name)) : [];
      }) : [];
    expect(paths.length, `${type} corpus coverage`).toBe(expectedCount);
    for (const path of paths) {
      const source = readFileSync(path, "utf8");
      const value = jsonBridge(parseYaml(source));
      const { className } = generalBinding(type);
      expect(() => validateGeneralMessage(type, value), path).not.toThrow();
      const { state } = toFormState(className, value);
      const out = toInstance(state);
      expect(out, path).toEqual(value);
      expect(() => validateGeneralMessage(type, out), path).not.toThrow();
      const saved = stringifyYamlPreservingSource(out, source);
      expect(saved === source, `${path}: saved YAML differs from its source bytes`).toBe(true);
    }
  });
});
