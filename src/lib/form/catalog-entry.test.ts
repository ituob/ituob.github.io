import { describe, expect, it } from "vitest";
import { REGISTERS_YAML, RECOMMENDATIONS_YAML } from "../../../test/fixtures/catalog";
import { catalogSlug, normalizeCatalogEntry, validateCatalogEntry, type CatalogContext, type CatalogEntryInput } from "./catalog-entry";
import { applyRegisterEntry, parseRecommendations, parseRegisters } from "./catalog-yaml";

const rows = parseRegisters(REGISTERS_YAML);
const ctx: CatalogContext = {
  existingIds: rows.map((r) => String(r.register_id)),
  existingSlugs: rows.map((r) => String(r.slug)),
  recommendations: parseRecommendations(RECOMMENDATIONS_YAML).map((r) => r.code),
};
const fresh: CatalogEntryInput = { id: "BUREAUFAX2", title: { en: "Bureaufax" }, url: "https://www.itu.int/pub/bf", recommendation: "E.164", key_field: "number" };
const codes = (input: CatalogEntryInput, original?: string) => validateCatalogEntry(input, ctx, original).map((i) => `${i.path}:${i.code}`);

describe("catalog entry validation (shared by the form and the Worker)", () => {
  it("accepts a complete new entry and an entry without a url", () => {
    expect(codes(fresh)).toEqual([]);
    expect(codes({ ...fresh, url: "" })).toEqual([]);
  });
  it("refuses a lowercase or malformed id", () => {
    expect(codes({ ...fresh, id: "bureaufax" })).toEqual(["id:type"]);
    expect(codes({ ...fresh, id: "A B" })).toEqual(["id:type"]);
    expect(codes({ ...fresh, id: "" })).toEqual(["id:required"]);
  });
  it("refuses a duplicate id, case-insensitively, and a colliding slug", () => {
    expect(codes({ ...fresh, id: "DP" })).toEqual(["id:duplicate"]);
    expect(codes({ ...fresh, id: "E118_IIN" })).toEqual(["id:duplicate"]);
    expect(codes({ ...fresh, id: "COAST.STATIONS" })).toEqual(["id:duplicate"]);
  });
  it("refuses a bad url", () => {
    for (const url of ["not a url", "ftp://x.example/a", "javascript:alert(1)", "https://u:p@x.example/", "https://x.example/a b"]) {
      expect(codes({ ...fresh, url }), url).toEqual(["url:type"]);
    }
  });
  it("requires a literal HTTPS prefix and a valid HTTPS host", () => {
    for (const url of ["http://x.example", "https:/x.example", "https:x.example", "HTTPS://x.example", "https:///x.example", "https://", "https://?q=x", "https:\\\\x.example", "https://x.example\\path"]) {
      expect(codes({ ...fresh, url }), url).toEqual(["url:type"]);
    }
    expect(codes({ ...fresh, url: "https://x.example" })).toEqual([]);
    expect(normalizeCatalogEntry({ ...fresh, url: "https://x.example" }).url).toBe("https://x.example/");
  });
  it("rejects every C0/C1 control, line separator, BOM, and lone surrogate before trimming", () => {
    const forbidden = [...Array.from({ length: 0x20 }, (_, i) => String.fromCharCode(i)), ...Array.from({ length: 0x21 }, (_, i) => String.fromCharCode(0x7f + i)), "\u2028", "\u2029", "\ufeff", "\ud800", "\udfff"];
    for (const char of forbidden) {
      expect(codes({ ...fresh, title: { en: ` ${char}Title ` } }), `title U+${char.charCodeAt(0).toString(16)}`).toContain("title.en:type");
      expect(codes({ ...fresh, url: `https://x.example/${char}` }), `url U+${char.charCodeAt(0).toString(16)}`).toContain("url:type");
    }
    expect(codes({ ...fresh, title: { en: "ITU 🌐" } })).toEqual([]);
    expect(codes({ ...fresh, url: "https://x.example/🌐" })).toEqual([]);
  });
  it("requires an English title, a known language, a catalog recommendation and a key field", () => {
    expect(codes({ ...fresh, title: { fr: "Titre" } })).toEqual(["title.en:required"]);
    expect(codes({ ...fresh, title: { en: "T", xx: "T" } })).toEqual(["title.xx:unknown"]);
    expect(codes({ ...fresh, recommendation: "Z.999" })).toEqual(["recommendation:enum"]);
    expect(codes({ ...fresh, recommendation: "" })).toEqual(["recommendation:required"]);
    expect(codes({ ...fresh, key_field: "" })).toEqual(["key_field:required"]);
  });
  it("refuses an id change on edit and edits an existing id", () => {
    expect(codes({ ...fresh, id: "DP2", key_field: undefined }, "DP")).toEqual(["id:mismatch"]);
    expect(codes({ id: "DP", title: { en: "New" }, recommendation: "E.164" }, "DP")).toEqual([]);
    expect(codes({ id: "GONE", title: { en: "New" }, recommendation: "E.164" }, "GONE")).toEqual(["id:unknown"]);
    // A legacy id that fails the create pattern stays editable because its id is fixed.
    expect(codes({ id: "List of Coast Stations", title: { en: "x" }, recommendation: "RR.25.1" }, "List of Coast Stations")).toEqual([]);
  });
  it("derives the slug like the site does", () => {
    expect(catalogSlug("RR.25.1")).toBe("rr-25-1");
    expect(catalogSlug("BUREAUFAX2")).toBe("bureaufax2");
  });
});

describe("registers.yaml edits", () => {
  it("appends only the new entry and keeps comments and other entries byte-identical", () => {
    const out = applyRegisterEntry(REGISTERS_YAML, fresh);
    expect(out.startsWith(REGISTERS_YAML.replace(/\n*$/, "\n"))).toBe(true);
    const added = parseRegisters(out).at(-1)!;
    expect(added).toMatchObject({ register_id: "BUREAUFAX2", slug: "bureaufax2", recommendation: "E.164", title: { en: "Bureaufax" }, url: "https://www.itu.int/pub/bf", key_field: "number", classification: "textual" });
    expect(parseRegisters(out)).toHaveLength(4);
  });
  it("edits title, url and recommendation of one entry and nothing else", () => {
    const out = applyRegisterEntry(REGISTERS_YAML, { id: "DP", title: { en: "Dialling", fr: "Numerotation" }, url: "https://www.itu.int/dp", recommendation: "E.118" }, "DP");
    const after = parseRegisters(out);
    expect(after[1]).toMatchObject({ register_id: "DP", recommendation: "E.118", title: { en: "Dialling", fr: "Numerotation" }, url: "https://www.itu.int/dp", key_field: "country_code", renderer: "dp-table" });
    expect(after[0]).toEqual(rows[0]);
    expect(after[2]).toEqual(rows[2]);
    expect(out).toContain("  # === External (not annexed) ===");
    const changed = out.split("\n").filter((line, i) => line !== REGISTERS_YAML.split("\n")[i]);
    expect(changed.length).toBeGreaterThan(0);
  });
  it("replaces a flow title and removes a cleared url", () => {
    const out = applyRegisterEntry(REGISTERS_YAML, { id: "List of Coast Stations", title: { en: "Coast" }, url: "", recommendation: "RR.25.1" }, "List of Coast Stations");
    const row = parseRegisters(out)[2]!;
    expect(row.title).toEqual({ en: "Coast" });
    expect(row).not.toHaveProperty("url");
    expect(row.external).toBe(true);
  });
  it("quotes hostile text so it stays one scalar", () => {
    const title = "Evil: { a: 1 }\n- register_id: X # c";
    const out = applyRegisterEntry(REGISTERS_YAML, { ...fresh, title: { en: title } });
    expect(parseRegisters(out)).toHaveLength(4);
    expect(parseRegisters(out)[3]!.title).toEqual({ en: title });
  });
  it("refuses to edit an id that is not in the file", () => {
    expect(() => applyRegisterEntry(REGISTERS_YAML, { id: "NOPE", title: { en: "x" }, recommendation: "E.164" }, "NOPE")).toThrow(/not found/);
  });
});
