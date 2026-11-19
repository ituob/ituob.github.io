/**
 * Downloads spot-check (ituob.github.io#112, "spot-check workflow").
 *
 * Picks N publication x language entries from the manifest and proves, for each,
 * that what a reader gets from the BUILT site matches the manifest:
 *   - the PDF is served (exists / HTTP 200), is a PDF, and its sha256 equals the manifest's;
 *   - the Downloads page links it with the same standard, edition, language and sha256;
 *   - the entry's edition card shows the status label for the manifest status
 *     (candidates also carry the unofficial-data disclaimer; adopted ones must not),
 *     and states the as-of issue.
 * A Source reads either a built dist directory or a live host, so one checker covers
 * the CI build and a staging or production host. Pure Node (runs under vitest and node).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  groupPublications,
  pdfHref,
  statusPresentation,
  type PublicationEntry,
} from "./publications.ts";

export interface Fetched {
  status: number;
  contentType: string | null;
  body: Buffer;
}
export type Source = (urlPath: string) => Promise<Fetched>;

export interface CheckResult {
  entry: PublicationEntry;
  href: string;
  ok: boolean;
  failures: string[];
  sha256Actual: string | null;
}

export const DISCLAIMER_FRAGMENT = "not an official ITU resource";

/** Evenly spaced deterministic pick over the sorted entries (all of them when n >= count). */
export function pickEntries(entries: readonly PublicationEntry[], n: number): PublicationEntry[] {
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  if (!Number.isInteger(n) || n < 1) throw new Error(`sample size must be a positive integer, got ${n}`);
  if (n >= sorted.length) return sorted;
  const picked = new Set<number>();
  for (let i = 0; i < n; i++) picked.add(Math.floor((i * sorted.length) / n));
  return [...picked].map((i) => sorted[i]!);
}

/** Source over a built dist directory: /downloads/x.pdf -> dist/downloads/x.pdf, /downloads/ -> index.html. */
export function distSource(dist: string): Source {
  return async (urlPath) => {
    let rel = decodeURIComponent(urlPath.replace(/^\//, ""));
    if (rel === "" || rel.endsWith("/")) rel += "index.html";
    const file = join(dist, rel);
    if (rel.split("/").includes("..") || !existsSync(file)) return { status: 404, contentType: null, body: Buffer.alloc(0) };
    return {
      status: 200,
      contentType: rel.endsWith(".pdf") ? "application/pdf" : rel.endsWith(".html") ? "text/html" : null,
      body: readFileSync(file),
    };
  };
}

/** Source over a live host (staging / production). */
export function httpSource(baseUrl: string): Source {
  const base = baseUrl.replace(/\/+$/, "");
  return async (urlPath) => {
    const res = await fetch(base + urlPath, { redirect: "follow" });
    return { status: res.status, contentType: res.headers.get("content-type"), body: Buffer.from(await res.arrayBuffer()) };
  };
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}=(?:"([^"]*)"|'([^']*)'|([^\\s>"']+))`).exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
}

const text = (html: string) =>
  html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

/** The edition card (<article data-edition-article ...>) for standard + edition year, or null. */
export function editionCard(html: string, standard: string, year: number): { open: string; inner: string } | null {
  const re = /<article\b[^>]*>/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (attr(m[0], "data-edition") !== `${standard}-${year}`) continue;
    const end = html.indexOf("</article>", m.index);
    return { open: m[0], inner: html.slice(m.index + m[0].length, end === -1 ? undefined : end) };
  }
  return null;
}

export async function spotCheck(
  entries: readonly PublicationEntry[],
  sample: readonly PublicationEntry[],
  source: Source,
): Promise<CheckResult[]> {
  const page = await source("/downloads/");
  const html = page.status === 200 ? page.body.toString("utf8") : "";
  const editionStatus = new Map(
    groupPublications(entries).flatMap((g) => g.editions.map((e) => [`${e.standard}-${e.edition_year}`, e.status] as const)),
  );

  const results: CheckResult[] = [];
  for (const entry of sample) {
    const href = pdfHref(entry);
    const failures: string[] = [];
    let sha256Actual: string | null = null;

    const pdf = await source(href);
    if (pdf.status !== 200) failures.push(`PDF ${href}: HTTP ${pdf.status} (missing)`);
    else {
      if (!/^application\/pdf\b/i.test(pdf.contentType ?? "")) failures.push(`PDF ${href}: Content-Type is ${pdf.contentType ?? "absent"}, expected application/pdf`);
      if (pdf.body.subarray(0, 5).toString("latin1") !== "%PDF-") failures.push(`PDF ${href}: does not start with %PDF-`);
      sha256Actual = createHash("sha256").update(pdf.body).digest("hex");
      if (sha256Actual !== entry.sha256) failures.push(`PDF ${href}: sha256 mismatch (manifest ${entry.sha256}, served ${sha256Actual})`);
    }

    if (page.status !== 200) failures.push(`Downloads page: HTTP ${page.status}`);
    else {
      const card = editionCard(html, entry.standard, entry.edition_year);
      if (!card) failures.push(`Downloads page: no edition card for ${entry.standard} ${entry.edition_year}`);
      else {
        const link = [...card.inner.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]).find((a) => attr(a, "href") === href);
        if (!link) failures.push(`Downloads page: no link to ${href}`);
        else {
          if (attr(link, "data-language") !== entry.language) failures.push(`link ${href}: data-language is ${attr(link, "data-language")}, manifest ${entry.language}`);
          if (attr(link, "data-sha256") !== entry.sha256) failures.push(`link ${href}: data-sha256 does not match the manifest`);
          const from = card.inner.indexOf(link);
          const close = card.inner.indexOf("</a>", from);
          const linkText = text(card.inner.slice(from, close === -1 ? undefined : close));
          const asOf = `as of OB No. ${entry.as_of_issue}`;
          if (!new RegExp(`\\bas of OB No\\. ${entry.as_of_issue}\\b`).test(linkText)) failures.push(`link ${href}: as-of issue "${asOf}" not stated`);
        }
        const status = editionStatus.get(`${entry.standard}-${entry.edition_year}`)!;
        const p = statusPresentation(status);
        const t = text(card.inner);
        if (attr(card.open, "data-status") !== status) failures.push(`edition card data-status is ${attr(card.open, "data-status")}, manifest implies ${status}`);
        if (!t.includes(p.label)) failures.push(`edition card lacks the "${p.label}" status label`);
        if (status === "candidate" && !t.includes(DISCLAIMER_FRAGMENT)) failures.push("candidate edition card lacks the unofficial-data disclaimer");
        if (status === "itu-adopted" && t.includes(DISCLAIMER_FRAGMENT)) failures.push("adopted edition card still shows the unofficial-data disclaimer");
        for (const other of ["candidate", "itu-adopted"] as const) {
          if (other !== status && t.includes(statusPresentation(other).label)) failures.push(`edition card shows the ${other} label but the manifest status is ${status}`);
        }
      }
    }
    results.push({ entry, href, ok: failures.length === 0, failures, sha256Actual });
  }
  return results;
}

export function renderReport(results: readonly CheckResult[], meta: { target: string; total: number; at: string; rejected?: readonly string[] }): string {
  const rejected = meta.rejected ?? [];
  const failed = results.filter((r) => !r.ok);
  const lines = [
    `## Downloads spot-check: ${failed.length === 0 && rejected.length === 0 ? "PASS" : "FAIL"}`,
    "",
    `- Target: ${meta.target}`,
    `- Checked ${results.length} of ${meta.total} manifest entries`,
    `- Time: ${meta.at}`,
    "",
    "| Standard | Edition | Lang | As of OB | Status | sha256 | Result |",
    "|---|---|---|---|---|---|---|",
    ...results.map(
      (r) =>
        `| ${r.entry.standard} | ${r.entry.edition_year} | ${r.entry.language} | ${r.entry.as_of_issue} | ${r.entry.status} | \`${(r.sha256Actual ?? "none").slice(0, 12)}\` | ${r.ok ? "ok" : "FAIL"} |`,
    ),
  ];
  if (rejected.length > 0) {
    lines.push("", `- Rejected ${rejected.length} manifest entries`, ...rejected.map((r) => `- Manifest entry rejected: ${r}`));
  }
  if (failed.length > 0) {
    lines.push("", "### Failures", ...failed.flatMap((r) => r.failures.map((f) => `- ${r.entry.path}: ${f}`)));
  }
  return lines.join("\n") + "\n";
}
