import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { verifyAndPlace, verifyDist } from "../src/lib/publications-place.ts";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** An artifact dir with manifest.json and PDFs; `tamper` swaps one file's bytes after hashing. */
function artifact(files: Record<string, string>, tamper?: string) {
  const dir = mkdtempSync(join(tmpdir(), "art-"));
  const publications = Object.entries(files).map(([path, body], i) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), tamper === path ? "tampered" : body);
    return {
      standard: `E.21${i}`, title: "T", edition_year: 2026, language: "en", as_of_issue: 1170,
      sha256: sha(Buffer.from(body)), status: "candidate", register_slugs: ["e212-mnc"], path,
    };
  });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ publications }));
  return dir;
}

const out = () => {
  const d = mkdtempSync(join(tmpdir(), "out-"));
  return { downloads: join(d, "public/downloads"), manifest: join(d, "src/data/publications-manifest.json") };
};

test("verified PDFs and manifest are placed", () => {
  const src = artifact({ "E.212/E.212-en.pdf": "%PDF-a", "E.212/E.212-fr.pdf": "%PDF-b" });
  const o = out();
  const r = verifyAndPlace(src, o.downloads, o.manifest);
  assert.equal(r.placed.length, 2);
  assert.equal(readFileSync(join(o.downloads, "E.212/E.212-fr.pdf"), "utf8"), "%PDF-b");
  assert.equal(readFileSync(o.manifest, "utf8"), readFileSync(join(src, "manifest.json"), "utf8"));
});

test("checksum mismatch throws and places nothing", () => {
  const src = artifact({ "a.pdf": "%PDF-a", "b.pdf": "%PDF-b" }, "b.pdf");
  const o = out();
  assert.throws(() => verifyAndPlace(src, o.downloads, o.manifest), /b\.pdf: sha256 mismatch/);
  assert.equal(existsSync(o.downloads), false);
  assert.equal(existsSync(o.manifest), false);
});

test("a PDF named by the manifest but absent throws", () => {
  const src = artifact({ "a.pdf": "%PDF-a" });
  writeFileSync(join(src, "a.pdf"), "x");
  const m = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8"));
  m.publications[0].path = "gone.pdf";
  writeFileSync(join(src, "manifest.json"), JSON.stringify(m));
  assert.throws(() => verifyAndPlace(src, out().downloads, out().manifest), /gone\.pdf: listed in the manifest but missing/);
});

test("missing manifest.json throws; unlisted PDFs are not placed; stale files are cleared", () => {
  const empty = mkdtempSync(join(tmpdir(), "art-"));
  assert.throws(() => verifyAndPlace(empty, out().downloads, out().manifest), /manifest\.json not found/);

  const src = artifact({ "a.pdf": "%PDF-a" });
  writeFileSync(join(src, "extra.pdf"), "not listed");
  const o = out();
  mkdirSync(o.downloads, { recursive: true });
  writeFileSync(join(o.downloads, "stale.pdf"), "old");
  verifyAndPlace(src, o.downloads, o.manifest);
  assert.equal(existsSync(join(o.downloads, "a.pdf")), true);
  assert.equal(existsSync(join(o.downloads, "extra.pdf")), false);
  assert.equal(existsSync(join(o.downloads, "stale.pdf")), false);
});

test("a traversal path is rejected by the loader and never placed", () => {
  const src = artifact({ "a.pdf": "%PDF-a" });
  const m = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8"));
  m.publications.push({ ...m.publications[0], standard: "X.1", path: "../evil.pdf" });
  writeFileSync(join(src, "manifest.json"), JSON.stringify(m));
  const o = out();
  const r = verifyAndPlace(src, o.downloads, o.manifest);
  assert.equal(r.placed.length, 1);
  assert.equal(r.rejected.length, 1);
});

test("verifyDist detects a changed PDF in dist and passes when absent manifest", () => {
  const src = artifact({ "a.pdf": "%PDF-a" });
  const o = out();
  verifyAndPlace(src, o.downloads, o.manifest);
  assert.deepEqual(verifyDist(o.manifest, o.downloads), []);
  writeFileSync(join(o.downloads, "a.pdf"), "changed");
  assert.match(verifyDist(o.manifest, o.downloads)[0]!, /sha256 mismatch/);
  assert.deepEqual(verifyDist(join(tmpdir(), "nope.json"), o.downloads), []);
});
