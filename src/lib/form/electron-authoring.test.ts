import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateGeneralMessage } from "../../../worker/lib/general-messages.ts";
import { generalBinding } from "./general.ts";
import { toFormState, toInstance } from "./model.ts";
import { parseYaml, stringifyYaml } from "./yaml-io.ts";

/**
 * Authoring parity with the retired Electron editor (ituob/itu-ob-editor 74b1564, src/models/messages/*):
 * a record authored from scratch through the web form model must be valid and must have the YAML shape
 * the old editor wrote, i.e. only key paths that exist in the real corpus (which the old editor wrote),
 * and every key the old editor's model requires.
 */
const corpusRoot = join(process.env["OB_DATA_ROOT"] ?? join(dirname(fileURLToPath(import.meta.url)), "../../../data-ob"), "ob-issues");

/** Key paths of a value; arrays collapse to `[]`; `contents`/prose leaves are not descended into. */
function keyPaths(value: unknown, prefix = "", into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) { for (const item of value) keyPaths(item, `${prefix}[]`, into); return into; }
  if (value && typeof value === "object" && !(value instanceof Date) && !("toISOString" in (value as object))) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key;
      into.add(path);
      const prose = path === "contents" && !Array.isArray(child) || path.endsWith("communications[].contents") || path.endsWith("title") || path.endsWith("country_name") || path.endsWith("contact");
      if (!prose) keyPaths(child, path, into);
    }
  }
  return into;
}

function corpusPaths(type: string): Set<string> {
  const all = new Set<string>();
  for (const issue of readdirSync(corpusRoot, { withFileTypes: true })) {
    const directory = join(corpusRoot, issue.name, type);
    if (!issue.isDirectory() || !existsSync(directory)) continue;
    for (const name of readdirSync(directory).filter(n => n.endsWith(".yaml"))) {
      keyPaths(parseYaml(readFileSync(join(directory, name), "utf8")), "", all);
    }
  }
  return all;
}

const authored: Record<string, { value: Record<string, unknown>; required: string[] }> = {
  // legacy TSCountryCommunicationSet: country_name, phone_code, communications[{date, contents}], contact
  telephone_service_2: {
    value: { type: "telephone_service_2", contents: [{
      type: "nnp", country_name: { en: "Exampleland" }, phone_code: "999", contact: { en: "Ministry\nTel: +999 1" },
      communications: [{ date: "2026-11-17", contents: { en: "New numbering plan." } }],
    }] },
    required: ["type", "contents", "contents[].country_name", "contents[].phone_code", "contents[].contact", "contents[].communications", "contents[].communications[].date"],
  },
  // legacy Message: type, recommendation, title (translatable), contents
  custom: {
    value: { type: "custom", title: { en: "Telegram Service", fr: "Service télégraphique" }, contents: { en: "Body" } },
    required: ["type", "title", "contents"],
  },
  // legacy freeform message: type + contents
  mid: { value: { type: "mid", contents: { en: "Maritime identification digits notice." } }, required: ["type", "contents"] },
  sanc: {
    value: { type: "sanc", contents: { en: "Note from TSB" }, items: [{ country: "Example", sanc: "7-001" }] },
    required: ["type", "contents"],
  },
};

describe("authoring parity with the Electron editor (D6, D7, D14, D15, D18)", () => {
  it("requires the real corpus (a missing checkout is a failure)", () => { expect(existsSync(corpusRoot), corpusRoot).toBe(true); });

  it("detects a key the Electron editor never wrote (control)", () => {
    expect([...keyPaths({ type: "custom", bogus: 1 })].filter(path => !corpusPaths("custom").has(path))).toEqual(["bogus"]);
  });

  it.each(Object.keys(authored))("%s authored from scratch is valid and has the legacy YAML shape", type => {
    const { value, required } = authored[type]!;
    const { className } = generalBinding(type);
    const out = toInstance(toFormState(className, value).state);
    expect(out).toEqual(value);
    expect(() => validateGeneralMessage(type, out)).not.toThrow();

    const yaml = stringifyYaml(out);
    const reparsed = JSON.parse(JSON.stringify(parseYaml(yaml)));
    expect(reparsed).toEqual(JSON.parse(JSON.stringify(value)));
    expect(() => validateGeneralMessage(type, reparsed)).not.toThrow();

    const paths = keyPaths(reparsed);
    for (const key of required) expect(paths, `${type}: legacy editor writes ${key}`).toContain(key);
    if (type === "sanc") paths.delete("items"), paths.delete("items[].country"), paths.delete("items[].sanc");
    const legacy = corpusPaths(type);
    const unknown = [...paths].filter(path => !legacy.has(path));
    expect(unknown, `${type}: key paths the Electron editor never wrote`).toEqual([]);
  });
});
