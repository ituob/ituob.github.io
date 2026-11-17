/**
 * Publications manifest loader (ituob.github.io#112, W1).
 *
 * The Service Publications PDF pipeline (spd#89) emits one manifest entry per
 * rendered publication x language. This module reads that manifest, validates
 * every entry and groups the result for the Downloads page. Nothing here is a
 * hand-maintained list: the page shows exactly what the manifest contains.
 *
 * Pure Node module (no Astro / alias imports) so it runs under `node --test`.
 *
 * Manifest path: `DOWNLOADS_MANIFEST` env var (absolute, or relative to the
 * project root), default `src/data/publications-manifest.json`
 * (the pipeline drop location; absent until spd#89 publishes, so nothing is
 * listed). Test fixtures live in tests/fixtures and are never a default..
 * Manifest shape: a JSON array of entries, or `{ "publications": [...] }`.
 */
import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export type PublicationStatus = "candidate" | "itu-adopted";

export interface PublicationEntry {
  /** Recommendation / standard code, e.g. "E.212". */
  standard: string;
  title: string;
  edition_year: number;
  /** Language code, e.g. "en". */
  language: string;
  /** OB issue number whose patch-log state the PDF represents. */
  as_of_issue: number;
  sha256: string;
  status: PublicationStatus;
  /** Register slugs (see catalogs.ts REGISTERS) the document covers. */
  register_slugs: string[];
  /** PDF path relative to the served downloads root (no leading slash). */
  path: string;
}

export interface Edition {
  standard: string;
  edition_year: number;
  title: string;
  status: PublicationStatus;
  register_slugs: string[];
  entries: PublicationEntry[];
}

export interface StandardGroup {
  standard: string;
  editions: Edition[];
}

export interface LoadResult {
  entries: PublicationEntry[];
  /** One message per rejected entry; rejected entries never reach the page. */
  rejected: string[];
}

export const CANDIDATE_LABEL = "Generated from the patch log, pending ITU adoption";
export const ADOPTED_LABEL = "Official ITU publication";
export const DOWNLOADS_URL_PREFIX = "/downloads/";
export const DEFAULT_MANIFEST_RELATIVE = "src/data/publications-manifest.json";

const SHA256_RE = /^[0-9a-f]{64}$/;
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const LANG_RE = /^[a-z]{2,3}(-[A-Za-z0-9]+)?$/;
const STATUSES: readonly string[] = ["candidate", "itu-adopted"];

// Resolved from the working directory, not import.meta.url: the bundled build
// runs from dist/.prerender/, so a file-relative root points at the wrong place.
// Astro and `npm test` both run from the project root.
const projectRoot = () => process.cwd();

export function defaultManifestPath(env: Record<string, string | undefined> = process.env): string {
  const configured = env.DOWNLOADS_MANIFEST?.trim();
  if (!configured) return resolve(projectRoot(), DEFAULT_MANIFEST_RELATIVE);
  return isAbsolute(configured) ? configured : resolve(projectRoot(), configured);
}

/** A safe relative path: no absolute, scheme, backslash, empty or `..` segments. */
export function isSafeRelativePath(p: string): boolean {
  // eslint-disable-next-line no-control-regex
  if (!p || /[\u0000-\u001f\u007f?#%]/.test(p) || p.startsWith("/") || p.includes("\\") || /^[a-z][a-z0-9+.-]*:/i.test(p)) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/** Validate one raw manifest record; returns the entry or a reason string. */
export function parseEntry(raw: unknown): PublicationEntry | string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "not an object";
  const r = raw as Record<string, unknown>;
  const str = (k: string) => (typeof r[k] === "string" && (r[k] as string).trim() !== "" ? (r[k] as string).trim() : null);
  const int = (k: string) => (typeof r[k] === "number" && Number.isInteger(r[k]) && (r[k] as number) > 0 ? (r[k] as number) : null);

  const standard = str("standard");
  const title = str("title");
  const language = str("language");
  const sha256 = str("sha256");
  const path = str("path");
  const edition_year = int("edition_year");
  const as_of_issue = int("as_of_issue");
  if (!standard) return "missing standard";
  if (!title) return `${standard}: missing title`;
  if (edition_year === null) return `${standard}: invalid edition_year`;
  if (!language || !LANG_RE.test(language)) return `${standard}: invalid language`;
  if (as_of_issue === null) return `${standard}/${language}: invalid as_of_issue`;
  if (!sha256 || !SHA256_RE.test(sha256)) return `${standard}/${language}: invalid sha256`;
  if (typeof r.status !== "string" || !STATUSES.includes(r.status)) return `${standard}/${language}: invalid status`;
  if (!path || !isSafeRelativePath(path) || !/\.pdf$/i.test(path)) return `${standard}/${language}: unsafe path (must be a relative .pdf)`;
  const slugs = r.register_slugs;
  if (!Array.isArray(slugs) || slugs.some((s) => typeof s !== "string" || !SLUG_RE.test(s))) {
    return `${standard}/${language}: invalid register_slugs`;
  }
  return {
    standard,
    title,
    edition_year,
    language,
    as_of_issue,
    sha256,
    status: r.status as PublicationStatus,
    register_slugs: [...(slugs as string[])],
    path,
  };
}

/** Parse manifest JSON text. Invalid entries (a failed render) are dropped and reported. */
export function parseManifest(text: string): LoadResult {
  const doc: unknown = JSON.parse(text);
  const list = Array.isArray(doc) ? doc : (doc as { publications?: unknown } | null)?.publications;
  if (!Array.isArray(list)) throw new Error("publications manifest: expected an array or { publications: [] }");
  const entries: PublicationEntry[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  const paths = new Set<string>();
  for (const raw of list) {
    const parsed = parseEntry(raw);
    if (typeof parsed === "string") {
      rejected.push(parsed);
      continue;
    }
    const key = `${parsed.standard}|${parsed.edition_year}|${parsed.language}`;
    if (seen.has(key)) {
      rejected.push(`${parsed.standard}/${parsed.language}: duplicate edition ${parsed.edition_year}`);
      continue;
    }
    if (paths.has(parsed.path)) {
      rejected.push(`${parsed.standard}/${parsed.language}: duplicate path ${parsed.path}`);
      continue;
    }
    seen.add(key);
    paths.add(parsed.path);
    entries.push(parsed);
  }
  return { entries, rejected };
}

/**
 * Load the manifest from disk. A missing default file yields an empty list (no
 * PDFs published yet); a missing file named by DOWNLOADS_MANIFEST is an error,
 * so a mistyped path cannot silently publish an empty page.
 */
export function loadPublications(manifestPath: string = defaultManifestPath()): LoadResult {
  if (!existsSync(manifestPath)) {
    if (process.env.DOWNLOADS_MANIFEST?.trim()) throw new Error(`DOWNLOADS_MANIFEST not found: ${manifestPath}`);
    return { entries: [], rejected: [] };
  }
  const result = parseManifest(readFileSync(manifestPath, "utf8"));
  for (const msg of result.rejected) console.warn(`[downloads] manifest entry rejected: ${msg}`);
  return result;
}

/** Natural order for Recommendation codes: series letter, then numeric parts. */
export function compareStandards(a: string, b: string): number {
  const na = a.match(/^([A-Za-z]+)[.\s]?(\d+)?(.*)$/);
  const nb = b.match(/^([A-Za-z]+)[.\s]?(\d+)?(.*)$/);
  if (!na || !nb) return a.localeCompare(b);
  if (na[1] !== nb[1]) return na[1]!.localeCompare(nb[1]!);
  const d = Number(na[2] ?? 0) - Number(nb[2] ?? 0);
  return d !== 0 ? d : (na[3] ?? "").localeCompare(nb[3] ?? "");
}

/** Group by Recommendation, then edition (newest first); languages sorted within an edition. */
export function groupPublications(entries: readonly PublicationEntry[]): StandardGroup[] {
  const byStandard = new Map<string, Map<number, PublicationEntry[]>>();
  for (const e of entries) {
    const editions = byStandard.get(e.standard) ?? new Map<number, PublicationEntry[]>();
    editions.set(e.edition_year, [...(editions.get(e.edition_year) ?? []), e]);
    byStandard.set(e.standard, editions);
  }
  return [...byStandard.keys()].sort(compareStandards).map((standard) => {
    const editions = [...byStandard.get(standard)!.entries()]
      .sort(([a], [b]) => b - a)
      .map(([edition_year, list]): Edition => {
        const sorted = [...list].sort((x, y) => x.language.localeCompare(y.language));
        return {
          standard,
          edition_year,
          title: sorted[0]!.title,
          // Official only when every language variant is adopted.
          status: sorted.every((e) => e.status === "itu-adopted") ? "itu-adopted" : "candidate",
          register_slugs: [...new Set(sorted.flatMap((e) => e.register_slugs))],
          entries: sorted,
        };
      });
    return { standard, editions };
  });
}

export interface StatusPresentation {
  label: string;
  official: boolean;
  /** Candidates keep the site's unofficial-data disclaimer wording. */
  showDisclaimer: boolean;
}

export function statusPresentation(status: PublicationStatus): StatusPresentation {
  return status === "itu-adopted"
    ? { label: ADOPTED_LABEL, official: true, showDisclaimer: false }
    : { label: CANDIDATE_LABEL, official: false, showDisclaimer: true };
}

export function pdfHref(entry: Pick<PublicationEntry, "path">): string {
  return DOWNLOADS_URL_PREFIX + entry.path.split("/").map(encodeURIComponent).join("/");
}

/** Search/palette label for an edition. */
export function editionLabel(e: Pick<Edition, "standard" | "edition_year">): string {
  return `ITU-T ${e.standard} (${e.edition_year} edition)`;
}
