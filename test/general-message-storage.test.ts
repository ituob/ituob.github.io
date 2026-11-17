import { expect, it } from "vitest";
import { MAX_STORED_BYTES, packJSON, packText, unpackJSON, unpackText } from "../worker/lib/general-message-storage.ts";
import { InvalidError } from "../worker/lib/membership.ts";

it("storage preserves plain small records and the JSON object contract", async () => {
  const value = { type: "custom", contents: "A small notice" };
  expect(await packText("plain YAML\n")).toBe("plain YAML\n");
  expect(await packJSON(value)).toBe(JSON.stringify(value));
  expect(await unpackJSON(JSON.stringify(value))).toEqual(value);
  await expect(packJSON("a user string" as unknown as Record<string, unknown>)).rejects.toBeInstanceOf(InvalidError);
  await expect(unpackJSON(JSON.stringify("a user string"))).rejects.toThrow(/object/);
});

it("storage round-trips large Unicode/BOM/CRLF text and valid JSON below each column budget", async () => {
  const text = "\uFEFF---\r\n# " + "Telephone café العربية 中文\r\n".repeat(90_000);
  expect(new TextEncoder().encode(text).length).toBeGreaterThan(2_000_000);
  const packed = await packText(text);
  expect(packed.startsWith("~ituob-gzip-v1:")).toBe(true);
  expect(new TextEncoder().encode(packed).length).toBeLessThanOrEqual(MAX_STORED_BYTES);
  expect(await unpackText(packed)).toBe(text);
  const value = { type: "custom", contents: text };
  const packedJSON = await packJSON(value);
  expect(typeof JSON.parse(packedJSON)).toBe("string");
  expect(new TextEncoder().encode(packedJSON).length).toBeLessThanOrEqual(MAX_STORED_BYTES);
  expect(await unpackJSON(packedJSON)).toEqual(value);
});

it("storage escapes its own marker rather than confusing literal text with an envelope", async () => {
  const text = "~ituob-gzip-v1:literal text";
  expect(await unpackText(await packText(text))).toBe(text);
});

it("storage explicitly rejects incompressible values outside the row budget", async () => {
  const bytes = new Uint8Array(420_000);
  for (let offset = 0; offset < bytes.length; offset += 65536) crypto.getRandomValues(bytes.subarray(offset, offset + 65536));
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  await expect(packText(btoa(binary))).rejects.toBeInstanceOf(InvalidError);
});
