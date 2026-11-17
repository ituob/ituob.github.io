import { describe, expect, it } from "vitest";
import { REGISTERS_YAML } from "../../../test/fixtures/catalog";
import { applyRegisterEntry, parseRegisters } from "./catalog-yaml";

const edited = { id: "DP", title: { en: "Dialling" }, recommendation: "E.164" };

describe("catalog YAML line endings", () => {
  it("keeps CRLF throughout an edit and preserves the other entries", () => {
    const crlf = REGISTERS_YAML.replace(/\r?\n/g, "\r\n");
    const out = applyRegisterEntry(crlf, edited, "DP");

    expect(out).not.toMatch(/(?<!\r)\n/);
    expect(out).toContain("\r\n");
    expect(parseRegisters(out)[1]).toMatchObject({ register_id: "DP", title: { en: "Dialling" }, recommendation: "E.164" });
    expect(parseRegisters(out)[0]).toEqual(parseRegisters(crlf)[0]);
    expect(parseRegisters(out)[2]).toEqual(parseRegisters(crlf)[2]);
  });

  it("keeps LF input as LF throughout an edit", () => {
    const out = applyRegisterEntry(REGISTERS_YAML, edited, "DP");

    expect(out).not.toContain("\r\n");
    expect(parseRegisters(out)[1]).toMatchObject({ register_id: "DP", title: { en: "Dialling" }, recommendation: "E.164" });
  });
});
