import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { distSource, pickEntries, renderReport, spotCheck, type Source } from "../src/lib/downloads-spot-check.ts";
import { ADOPTED_LABEL, CANDIDATE_LABEL, groupPublications, pdfHref, type PublicationEntry } from "../src/lib/publications.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const tmp: string[] = [];
afterEach(() => tmp.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function entry(over: Partial<PublicationEntry> = {}): PublicationEntry {
  const language = over.language ?? "en";
  return {
    standard: "E.212", title: "Mobile network codes", edition_year: 2026, language, as_of_issue: 1170,
    sha256: sha(`%PDF-1.7 ${language}`), status: "candidate", register_slugs: ["e212-mnc"],
    path: `E.212/E.212-${language}.pdf`, ...over,
  };
}

/** Mimics src/pages/downloads/index.astro + DownloadStatus.astro output (attributes quoted or not). */
function page(entries: PublicationEntry[], tweak: (h: string) => string = (h) => h): string {
  const cards = groupPublications(entries).flatMap((g) => g.editions).map((ed) => {
    const p = ed.status === "itu-adopted" ? ADOPTED_LABEL : CANDIDATE_LABEL;
    const disclaimer = ed.status === "candidate" ? `<p class="download-disclaimer">This is not an official ITU resource. The data has not been validated.</p>` : "";
    const links = ed.entries.map((e) => `<li><a href="${pdfHref(e)}" download data-file data-standard=${e.standard} data-edition-year=${e.edition_year} data-language=${e.language} data-sha256=${e.sha256}><span>${e.language}</span><span>PDF · as of OB No. ${e.as_of_issue}</span></a></li>`).join("");
    return `<article data-edition="${ed.standard}-${ed.edition_year}" data-edition-article data-status="${ed.status}"><h3>${ed.title}</h3><div class="download-status" data-status="${ed.status}"><p class="download-label">${p}</p>${disclaimer}</div><ul>${links}</ul></article>`;
  });
  return tweak(`<html><body>${cards.join("")}</body></html>`);
}

/** Build a dist dir; `pdf` overrides the bytes written for a path. */
function dist(entries: PublicationEntry[], opts: { pdf?: Record<string, string>; html?: (h: string) => string; omit?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dist-"));
  tmp.push(dir);
  for (const e of entries) {
    if (opts.omit?.includes(e.path)) continue;
    const f = join(dir, "downloads", e.path);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, opts.pdf?.[e.path] ?? `%PDF-1.7 ${e.language}`);
  }
  mkdirSync(join(dir, "downloads"), { recursive: true });
  writeFileSync(join(dir, "downloads", "index.html"), page(entries, opts.html));
  return distSource(dir);
}

const all = [entry({ language: "en" }), entry({ language: "fr" })];
const run = (entries: PublicationEntry[], src: Source) => spotCheck(entries, entries, src);

describe("downloads spot-check", () => {
  it("passes when files, links and status labels match the manifest", async () => {
    const r = await run(all, dist(all));
    expect(r.map((x) => x.failures)).toEqual([[], []]);
    expect(r.every((x) => x.ok)).toBe(true);
  });

  it("passes an adopted edition and requires its label without the disclaimer", async () => {
    const adopted = all.map((e) => ({ ...e, status: "itu-adopted" as const }));
    expect((await run(adopted, dist(adopted))).every((x) => x.ok)).toBe(true);
  });

  it("fails on a sha256 mismatch (served bytes differ from the manifest)", async () => {
    const r = await run(all, dist(all, { pdf: { "E.212/E.212-fr.pdf": "%PDF-1.7 tampered" } }));
    expect(r[0]!.ok).toBe(true);
    expect(r[1]!.ok).toBe(false);
    expect(r[1]!.failures.join("\n")).toMatch(/sha256 mismatch/);
  });

  it("fails on a missing PDF", async () => {
    const r = await run(all, dist(all, { omit: ["E.212/E.212-en.pdf"] }));
    expect(r[0]!.ok).toBe(false);
    expect(r[0]!.failures.join("\n")).toMatch(/HTTP 404 \(missing\)/);
  });

  it("fails when the page shows the wrong status label for a candidate", async () => {
    const r = await run(all, dist(all, { html: (h) => h.replace(CANDIDATE_LABEL, ADOPTED_LABEL) }));
    const f = r[0]!.failures.join("\n");
    expect(r[0]!.ok).toBe(false);
    expect(f).toMatch(/lacks the "Generated from the patch log/);
    expect(f).toMatch(/shows the itu-adopted label/);
  });

  it("fails when a candidate loses its disclaimer, or an adopted edition keeps it", async () => {
    const noDisc = await run(all, dist(all, { html: (h) => h.replace(/<p class="download-disclaimer">.*?<\/p>/g, "") }));
    expect(noDisc[0]!.failures.join("\n")).toMatch(/lacks the unofficial-data disclaimer/);
    const adopted = all.map((e) => ({ ...e, status: "itu-adopted" as const }));
    const stale = await run(adopted, dist(adopted, { html: (h) => h.replace("</div>", `<p>This is not an official ITU resource.</p></div>`) }));
    expect(stale[0]!.failures.join("\n")).toMatch(/still shows the unofficial-data disclaimer/);
  });

  it("fails when the page has no link, wrong as-of issue, wrong sha256 attribute or no card", async () => {
    expect((await run(all, dist(all, { html: (h) => h.replace(`href="${pdfHref(all[0]!)}"`, 'href="/downloads/other.pdf"') })))[0]!.failures.join("\n")).toMatch(/no link to/);
    expect((await run(all, dist(all, { html: (h) => h.replaceAll("as of OB No. 1170", "as of OB No. 1100") })))[0]!.failures.join("\n")).toMatch(/as-of issue/);
    expect((await run(all, dist(all, { html: (h) => h.replace(`data-sha256=${all[0]!.sha256}`, `data-sha256=${"0".repeat(64)}`) })))[0]!.failures.join("\n")).toMatch(/data-sha256/);
    expect((await run(all, dist(all, { html: () => "<html></html>" })))[0]!.failures.join("\n")).toMatch(/no edition card/);
  });

  it("fails every entry when the downloads page is absent", async () => {
    const src: Source = async (p) => (p === "/downloads/" ? { status: 404, contentType: null, body: Buffer.alloc(0) } : distSourceOk(p));
    const distOk = dist(all);
    async function distSourceOk(p: string) { return distOk(p); }
    const r = await run(all, src);
    expect(r.every((x) => !x.ok && x.failures.some((f) => /Downloads page: HTTP 404/.test(f)))).toBe(true);
  });

  it("fails when a PDF is served with the wrong Content-Type or is not a PDF", async () => {
    const good = dist(all);
    const r = await run(all, async (p) => (p.endsWith("-en.pdf") ? { ...(await good(p)), contentType: "text/html" } : good(p)));
    expect(r[0]!.failures.join("\n")).toMatch(/Content-Type is text\/html/);
    const bad = await run(all, dist(all, { pdf: { "E.212/E.212-en.pdf": "<html>" } }));
    expect(bad[0]!.failures.join("\n")).toMatch(/does not start with %PDF-/);
  });

  it("samples deterministically, spread across entries, and clamps to the manifest size", () => {
    const many = ["ar", "en", "es", "fr", "ru", "zh"].map((language) => entry({ language }));
    expect(pickEntries(many, 3).map((e) => e.language)).toEqual(["ar", "es", "ru"]);
    expect(pickEntries(many, 99)).toHaveLength(6);
    expect(() => pickEntries(many, 0)).toThrow(/positive integer/);
  });

  it("renders a report that names the failure", async () => {
    const r = await run(all, dist(all, { omit: ["E.212/E.212-en.pdf"] }));
    const md = renderReport(r, { target: "dist", total: 2, at: "t" });
    expect(md).toMatch(/Downloads spot-check: FAIL/);
    expect(md).toMatch(/E\.212-en\.pdf: PDF \/downloads.*HTTP 404 \(missing\)/);
  });
});
