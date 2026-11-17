// Minimal, comment-preserving edits of catalogs/registers.yaml. Only the
// entry being created or edited changes; the result is parsed and compared
// with the original so any other difference is refused.

import { parse } from "yaml";
import { catalogSlug, normalizeCatalogEntry, type CatalogEntryInput } from "./catalog-entry";
import { SUPPORTED_LANGUAGES } from "../catalogs";

type Row = Record<string, unknown>;
const q = (value: string) => JSON.stringify(value); // a JSON string is a valid YAML double-quoted scalar

export function parseRegisters(text: string): Row[] {
  const list = (parse(text) as { registers?: unknown } | null)?.registers;
  if (!Array.isArray(list) || list.some((row) => !row || typeof row !== "object")) throw new Error("registers.yaml has no registers list");
  return list as Row[];
}

export function parseRecommendations(text: string): { code: string; title: Record<string, string> }[] {
  const list = (parse(text) as { recommendations?: unknown } | null)?.recommendations;
  if (!Array.isArray(list)) throw new Error("recommendations.yaml has no recommendations list");
  return list.filter((r): r is { code: string; title: Record<string, string> } => !!r && typeof (r as Row).code === "string");
}

function titleLines(title: Record<string, string>): string[] {
  const langs = (SUPPORTED_LANGUAGES as readonly string[]).filter((l) => title[l] !== undefined);
  return ["    title:", ...langs.map((l) => `      ${l}: ${q(title[l]!)}`)];
}

const stable = (value: unknown): string => JSON.stringify(value, (_k, v) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : 1)) : v);

/** Apply a create (`original` undefined) or an edit of `original` to registers.yaml text. */
export function applyRegisterEntry(text: string, raw: CatalogEntryInput, original?: string): string {
  const input = normalizeCatalogEntry(raw);
  const before = parseRegisters(text);
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  let next: string[];
  if (original === undefined) {
    const tail = ["  - register_id: " + q(input.id), `    slug: ${q(catalogSlug(input.id))}`, `    recommendation: ${q(input.recommendation)}`, ...titleLines(input.title),
      ...(input.url ? [`    url: ${q(input.url)}`] : []), `    key_field: ${q(input.key_field!)}`, "    classification: textual", "    renderer: text-amendment"];
    const body = text.replace(/(?:\r?\n)*$/, "");
    next = [...body.split(/\r?\n/), "", ...tail, ""];
  } else {
    const start = lines.findIndex((line) => {
      const m = /^  - register_id:\s*(.*?)\s*$/.exec(line);
      return !!m && String(parse(m[1]!)) === original;
    });
    if (start < 0) throw new Error(`register ${original} not found`);
    let end = start + 1;
    while (end < lines.length && !/^  (- |#)/.test(lines[end]!) && !/^\S/.test(lines[end]!)) end++;
    while (end > start + 1 && lines[end - 1]!.trim() === "") end--;
    const kept: string[] = [lines[start]!];
    let skipping = false;
    for (const line of lines.slice(start + 1, end)) {
      const key = /^    ([A-Za-z_]+):/.exec(line)?.[1];
      if (key) skipping = ["title", "recommendation", "url"].includes(key);
      else if (!/^     /.test(line) && line.trim() !== "") skipping = false;
      if (!skipping) kept.push(line);
    }
    const at = Math.max(1, kept.findIndex((l) => /^    slug:/.test(l)) + 1);
    kept.splice(at, 0, `    recommendation: ${q(input.recommendation)}`, ...titleLines(input.title), ...(input.url ? [`    url: ${q(input.url)}`] : []));
    next = [...lines.slice(0, start), ...kept, ...lines.slice(end)];
  }
  const result = next.join(newline);

  // Round-trip proof: nothing but the intended entry may differ.
  const after = parseRegisters(result);
  const target = original ?? input.id;
  const expectedCount = original === undefined ? before.length + 1 : before.length;
  if (after.length !== expectedCount) throw new Error("catalog edit changed the number of registers");
  const others = (rows: Row[]) => rows.filter((r) => r.register_id !== target).map(stable);
  if (stable(others(before)) !== stable(others(after))) throw new Error("catalog edit changed another register");
  const row = after.find((r) => r.register_id === target);
  const prior = before.find((r) => r.register_id === target);
  const expected: Row = { ...(prior ?? {}), register_id: target, recommendation: input.recommendation, title: input.title };
  if (input.url) expected.url = input.url; else delete expected.url;
  if (original === undefined) Object.assign(expected, { slug: catalogSlug(input.id), key_field: input.key_field, classification: "textual", renderer: "text-amendment" });
  if (!row || stable(row) !== stable(expected)) throw new Error("catalog edit did not round-trip");
  return result;
}
