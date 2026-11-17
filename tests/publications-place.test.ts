import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { selectRun, verifyAndPlace, verifyDist, type RunInfo } from "../src/lib/publications-place.ts";

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

test("a traversal path is rejected by the loader: the fetch fails and nothing is placed", () => {
  const src = artifact({ "a.pdf": "%PDF-a" });
  const m = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8"));
  m.publications.push({ ...m.publications[0], standard: "X.1", path: "../evil.pdf" });
  writeFileSync(join(src, "manifest.json"), JSON.stringify(m));
  const o = out();
  assert.throws(() => verifyAndPlace(src, o.downloads, o.manifest), /manifest entries rejected/);
  assert.equal(existsSync(o.downloads), false);
  assert.equal(existsSync(o.manifest), false);
});

test("an uppercase sha256 is rejected and fails the fetch", () => {
  const src = artifact({ "a.pdf": "%PDF-a" });
  const m = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8"));
  m.publications[0].sha256 = m.publications[0].sha256.toUpperCase();
  writeFileSync(join(src, "manifest.json"), JSON.stringify(m));
  const o = out();
  assert.throws(() => verifyAndPlace(src, o.downloads, o.manifest), /invalid sha256/);
  assert.equal(existsSync(o.downloads), false);
});

test("an empty manifest places nothing (the caller turns that into a PUBLICATIONS_REQUIRED failure)", () => {
  const src = mkdtempSync(join(tmpdir(), "art-"));
  writeFileSync(join(src, "manifest.json"), JSON.stringify({ publications: [] }));
  assert.equal(verifyAndPlace(src, out().downloads, out().manifest).placed.length, 0);
});

test("a symlinked PDF is refused and its target is never copied", () => {
  const src = artifact({ "a.pdf": "%PDF-a" });
  const secret = join(mkdtempSync(join(tmpdir(), "outside-")), "secret.txt");
  writeFileSync(secret, "SECRET");
  rmSync(join(src, "a.pdf"));
  symlinkSync(secret, join(src, "a.pdf"));
  const m = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8"));
  m.publications[0].sha256 = sha(Buffer.from("SECRET"));
  writeFileSync(join(src, "manifest.json"), JSON.stringify(m));
  const o = out();
  assert.throws(() => verifyAndPlace(src, o.downloads, o.manifest), /symlink/);
  assert.equal(existsSync(o.downloads), false);
});

test("a PDF under a symlinked directory is refused", () => {
  const src = artifact({ "a.pdf": "%PDF-a" });
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  writeFileSync(join(outside, "b.pdf"), "SECRET");
  symlinkSync(outside, join(src, "d"));
  const m = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8"));
  m.publications.push({ ...m.publications[0], standard: "X.1", path: "d/b.pdf", sha256: sha(Buffer.from("SECRET")) });
  writeFileSync(join(src, "manifest.json"), JSON.stringify(m));
  const o = out();
  assert.throws(() => verifyAndPlace(src, o.downloads, o.manifest), /d\/b\.pdf: is or passes through a symlink/);
  assert.equal(existsSync(o.downloads), false);
});

test("a symlinked manifest.json is refused", () => {
  const src = mkdtempSync(join(tmpdir(), "art-"));
  const real = join(mkdtempSync(join(tmpdir(), "outside-")), "m.json");
  writeFileSync(real, JSON.stringify({ publications: [] }));
  symlinkSync(real, join(src, "manifest.json"));
  assert.throws(() => verifyAndPlace(src, out().downloads, out().manifest), /manifest\.json is a symlink/);
});

const run = (o: Partial<RunInfo>): RunInfo => ({
  id: 1, event: "push", head_branch: "main", head_sha: "abc", conclusion: "success",
  created_at: "2026-01-01T00:00:00Z", head_repository: { full_name: "ituob/service-publications-docs" }, ...o,
});
const REPO = "ituob/service-publications-docs";

test("selectRun takes the newest trusted run and ignores PR, fork, failed and other-branch runs", () => {
  const runs = [
    run({ id: 9, event: "pull_request", created_at: "2026-03-01T00:00:00Z" }),
    run({ id: 8, head_repository: { full_name: "evil/fork" }, created_at: "2026-03-01T00:00:00Z" }),
    run({ id: 7, head_repository: null, created_at: "2026-03-01T00:00:00Z" }),
    run({ id: 6, conclusion: "failure", created_at: "2026-03-01T00:00:00Z" }),
    run({ id: 5, head_branch: "other", created_at: "2026-03-01T00:00:00Z" }),
    run({ id: 2, event: "workflow_dispatch", created_at: "2026-02-01T00:00:00Z" }),
    run({ id: 1, created_at: "2026-01-01T00:00:00Z" }),
  ];
  assert.equal(selectRun(runs, REPO, "main")?.id, 2);
  assert.equal(selectRun(runs.slice(0, 5), REPO, "main"), undefined);
});

test("verifyDist fails on unlisted files and on a missing manifest unless dist/downloads is empty", () => {
  const src = artifact({ "a.pdf": "%PDF-a" });
  const o = out();
  verifyAndPlace(src, o.downloads, o.manifest);
  writeFileSync(join(o.downloads, "extra.pdf"), "x");
  assert.match(verifyDist(o.manifest, o.downloads)[0]!, /extra\.pdf: in dist\/downloads but not listed/);
  const nope = join(tmpdir(), "nope-manifest.json");
  assert.match(verifyDist(nope, o.downloads)[0]!, /no manifest/);
  assert.deepEqual(verifyDist(nope, join(tmpdir(), "no-such-dist")), []);
  assert.deepEqual(verifyDist(nope, mkdtempSync(join(tmpdir(), "empty-"))), []);
});

test("verifyDist detects a changed PDF in dist", () => {
  const src = artifact({ "a.pdf": "%PDF-a" });
  const o = out();
  verifyAndPlace(src, o.downloads, o.manifest);
  assert.deepEqual(verifyDist(o.manifest, o.downloads), []);
  writeFileSync(join(o.downloads, "a.pdf"), "changed");
  assert.match(verifyDist(o.manifest, o.downloads)[0]!, /sha256 mismatch/);
});

test("verifyDist ignores the downloads page itself but not unlisted PDFs", () => {
  const nope = join(tmpdir(), "no-such-manifest.json");
  const d = mkdtempSync(join(tmpdir(), "page-"));
  writeFileSync(join(d, "index.html"), "<html></html>");
  assert.deepEqual(verifyDist(nope, d), []);
  writeFileSync(join(d, "Stray.PDF"), "x");
  assert.match(verifyDist(nope, d)[0]!, /Stray\.PDF: in dist\/downloads but there is no manifest/);
});
