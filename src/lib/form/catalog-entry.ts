// Service-publication (register) catalog entry: one validator shared by the
// /admin/catalog form (client) and the Worker (server), so both sides refuse
// exactly the same input. Pure TypeScript, no I/O.

import { SUPPORTED_LANGUAGES } from "../catalogs";

export interface CatalogEntryInput {
  /** Register id (catalogs/registers.yaml `register_id`). Fixed after creation. */
  id: string;
  /** Translatable title: language code to text; `en` is required. */
  title: Record<string, string>;
  /** Authoritative resource URL; empty or absent means none. */
  url?: string | null;
  /** Recommendation code from catalogs/recommendations.yaml, e.g. E.164. */
  recommendation: string;
  /** Identity field of the register's entries. Required on create only. */
  key_field?: string;
}

export type CatalogIssueCode = "required" | "type" | "enum" | "mismatch" | "unknown" | "duplicate";
export interface CatalogIssue { path: string; code: CatalogIssueCode; message: string }

export interface CatalogContext {
  /** Register ids already in the catalog. */
  existingIds: readonly string[];
  /** Register slugs already in the catalog. */
  existingSlugs: readonly string[];
  /** Recommendation codes in the catalog. */
  recommendations: readonly string[];
}

export const CATALOG_ID_PATTERN = /^[A-Z0-9][A-Z0-9_.]{0,63}$/;
export const RECOMMENDATION_PATTERN = /^[A-Za-z]+\.[0-9A-Za-z.]+$/;
export const KEY_FIELD_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
export const MAX_TITLE = 500;
export const MAX_URL = 2048;

const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f\\u2028\\u2029]");

/** Filesystem slug for a new register id (same rule as slugForPublicationId). */
export function catalogSlug(id: string): string {
  return id.toLowerCase().replace(/\./g, "-").replace(/[^a-z0-9-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-|-$/g, "");
}

/** Normalise form input: trim, drop empty translations and an empty URL. */
export function normalizeCatalogEntry(input: CatalogEntryInput): CatalogEntryInput {
  const title: Record<string, string> = {};
  for (const [lang, text] of Object.entries(input.title ?? {})) {
    if (typeof text === "string" && text.trim() !== "") title[lang] = text.trim();
  }
  const url = typeof input.url === "string" && input.url.trim() !== "" ? input.url.trim() : null;
  const out: CatalogEntryInput = { id: String(input.id ?? "").trim(), title, url, recommendation: String(input.recommendation ?? "").trim() };
  if (input.key_field !== undefined) out.key_field = String(input.key_field).trim();
  return out;
}

export function validateUrl(url: string): string | null {
  if (url.length > MAX_URL || CONTROL.test(url) || /\s/.test(url)) return "must be a single line without spaces and at most 2048 characters";
  let parsed: URL;
  try { parsed = new URL(url); } catch { return "must be an absolute URL such as https://www.itu.int/..."; }
  if (!["https:", "http:"].includes(parsed.protocol) || !parsed.hostname) return "must be an http or https URL";
  if (parsed.username || parsed.password) return "must not contain credentials";
  return null;
}

/**
 * Validate a create (`original` undefined) or an edit (`original` is the id
 * being edited). The same function runs in the browser and the Worker.
 */
export function validateCatalogEntry(raw: CatalogEntryInput, ctx: CatalogContext, original?: string): CatalogIssue[] {
  const issues: CatalogIssue[] = [];
  const input = normalizeCatalogEntry(raw);
  const editing = original !== undefined;
  const add = (path: string, code: CatalogIssueCode, message: string) => issues.push({ path, code, message });

  if (editing) {
    if (input.id !== original) add("id", "mismatch", "The id of a service publication cannot be changed after it is created.");
    if (!ctx.existingIds.includes(original!)) add("id", "unknown", `No service publication has the id ${original}.`);
  } else {
    if (input.id === "") add("id", "required", "Enter a publication id.");
    else if (!CATALOG_ID_PATTERN.test(input.id)) add("id", "type", "Use an uppercase English id of letters, digits, underscore and dot, e.g. BUREAUFAX.");
    else {
      const slug = catalogSlug(input.id);
      if (ctx.existingIds.some((id) => id.toLowerCase() === input.id.toLowerCase())) add("id", "duplicate", `A service publication with id ${input.id} already exists.`);
      else if (slug === "" || ctx.existingSlugs.includes(slug)) add("id", "duplicate", `The slug ${slug || "(empty)"} derived from this id is already in use.`);
    }
    if (!input.key_field) add("key_field", "required", "Enter the identity field of the register's entries.");
    else if (!KEY_FIELD_PATTERN.test(input.key_field)) add("key_field", "type", "Use lowercase letters, digits and underscore, e.g. callsign.");
  }

  for (const lang of Object.keys(input.title)) {
    if (!(SUPPORTED_LANGUAGES as readonly string[]).includes(lang)) add(`title.${lang}`, "unknown", `${lang} is not a supported language.`);
    else if (input.title[lang]!.length > MAX_TITLE || CONTROL.test(input.title[lang]!)) add(`title.${lang}`, "type", "Use a single line of at most 500 characters.");
  }
  if (!input.title.en) add("title.en", "required", "Enter the title in English.");

  if (input.url !== null) {
    const problem = validateUrl(input.url!);
    if (problem) add("url", "type", `The URL ${problem}.`);
  }

  if (input.recommendation === "") add("recommendation", "required", "Select a recommendation.");
  else if (!RECOMMENDATION_PATTERN.test(input.recommendation) || !ctx.recommendations.includes(input.recommendation)) add("recommendation", "enum", "Select a recommendation from the catalog.");
  return issues;
}
