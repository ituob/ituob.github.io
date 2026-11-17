/**
 * Verify and place the spd PDF artifact (ituob.github.io#112, W5).
 *
 * Input: a directory holding `manifest.json` and the PDFs at the paths the
 * manifest names (the layout of the spd `publications` artifact). Every
 * sha256 is checked against the manifest BEFORE anything is placed; a mismatch,
 * a missing PDF or an unparseable manifest throws, so the build fails instead of
 * publishing an unverified file. An entry the site loader rejects also throws
 * (nothing is silently dropped), and a symlink anywhere on a listed path, or as
 * manifest.json, is refused. Pure Node, runs under `node --test`.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parseManifest, type PublicationEntry } from "./publications.ts";

export interface PlaceResult {
  placed: PublicationEntry[];
  rejected: string[];
}

export function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** True when `rel` under `root` (or any directory on the way) is a symlink. Missing parts are not symlinks. */
export function hasSymlink(root: string, rel: string): boolean {
  let cur = root;
  for (const part of rel.split("/")) {
    cur = join(cur, part);
    try {
      if (lstatSync(cur).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** Check every entry's PDF under `root` against its manifest sha256; returns one message per failure. */
export function checkEntries(root: string, entries: readonly PublicationEntry[]): string[] {
  const errors: string[] = [];
  for (const e of entries) {
    const file = join(root, e.path);
    if (hasSymlink(root, e.path)) {
      errors.push(`${e.path}: is or passes through a symlink`);
      continue;
    }
    if (!existsSync(file)) {
      errors.push(`${e.path}: listed in the manifest but missing`);
      continue;
    }
    const actual = sha256File(file);
    if (actual !== e.sha256) errors.push(`${e.path}: sha256 mismatch (manifest ${e.sha256}, file ${actual})`);
  }
  return errors;
}

/**
 * Verify `srcDir` against its manifest, then copy the manifest to `manifestOut`
 * and the PDFs to `downloadsDir`. `downloadsDir` is cleared first so a stale
 * PDF from an earlier run is never served.
 */
export function verifyAndPlace(srcDir: string, downloadsDir: string, manifestOut: string): PlaceResult {
  const manifestFile = join(srcDir, "manifest.json");
  if (!existsSync(manifestFile)) throw new Error(`manifest.json not found in ${srcDir}`);
  if (hasSymlink(srcDir, "manifest.json")) throw new Error("manifest.json is a symlink");
  const text = readFileSync(manifestFile, "utf8");
  const { entries, rejected } = parseManifest(text);
  if (rejected.length > 0) throw new Error(`manifest entries rejected:\n  ${rejected.join("\n  ")}`);
  const errors = checkEntries(srcDir, entries);
  if (errors.length > 0) throw new Error(`publication checksum verification failed:\n  ${errors.join("\n  ")}`);

  rmSync(downloadsDir, { recursive: true, force: true });
  for (const e of entries) {
    const dest = join(downloadsDir, e.path);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(srcDir, e.path), dest);
  }
  mkdirSync(dirname(manifestOut), { recursive: true });
  writeFileSync(manifestOut, text);
  return { placed: entries, rejected };
}

/** Every file under `dir`, as POSIX paths relative to it (symlinks are listed, never followed). */
function listFiles(dir: string, base: string = dir): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, d.name);
    if (d.isDirectory()) out.push(...listFiles(full, base));
    else out.push(relative(base, full).split("\\").join("/"));
  }
  return out;
}

/**
 * Post-build guard: dist/downloads must hold exactly the manifest's PDFs. An
 * absent manifest passes only when dist/downloads holds no PDF. Non-PDF files are
 * the site's own pages (the downloads page builds to dist/downloads/index.html).
 */
export function verifyDist(manifestFile: string, distDownloads: string): string[] {
  const present = listFiles(distDownloads).filter((f) => f.toLowerCase().endsWith(".pdf"));
  if (!existsSync(manifestFile)) return present.map((f) => `${f}: in dist/downloads but there is no manifest`);
  const { entries, rejected } = parseManifest(readFileSync(manifestFile, "utf8"));
  const errors = rejected.map((r) => `manifest entry rejected: ${r}`);
  errors.push(...checkEntries(distDownloads, entries));
  const listed = new Set(entries.map((e) => e.path));
  for (const f of present) if (!listed.has(f)) errors.push(`${f}: in dist/downloads but not listed in the manifest`);
  return errors;
}

/** One workflow run as returned by the Actions REST API (only the fields used). */
export interface RunInfo {
  id: number;
  event: string;
  head_branch: string | null;
  head_sha: string;
  status?: string;
  conclusion: string | null;
  created_at: string;
  head_repository: { full_name: string } | null;
}

const TRUSTED_EVENTS = new Set(["push", "workflow_dispatch"]);

/**
 * Newest successful run that is reviewed code: event push or workflow_dispatch,
 * on `branch`, whose head repository is `repo` itself (never a fork, never a
 * pull_request run, whatever branch name it carries).
 */
export function selectRun(runs: readonly RunInfo[], repo: string, branch: string): RunInfo | undefined {
  return runs
    .filter(
      (r) =>
        r.conclusion === "success" &&
        TRUSTED_EVENTS.has(r.event) &&
        r.head_branch === branch &&
        r.head_repository?.full_name === repo,
    )
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
}
