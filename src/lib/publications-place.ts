/**
 * Verify and place the spd PDF artifact (ituob.github.io#112, W5).
 *
 * Input: a directory holding `manifest.json` and the PDFs at the paths the
 * manifest names (the layout of the spd `publications` artifact). Every
 * sha256 is checked against the manifest BEFORE anything is placed; a mismatch,
 * a missing PDF or an unparseable manifest throws, so the build fails instead of
 * publishing an unverified file. Entries the site loader rejects are reported
 * and never placed. Pure Node, runs under `node --test`.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseManifest, type PublicationEntry } from "./publications.ts";

export interface PlaceResult {
  placed: PublicationEntry[];
  rejected: string[];
}

export function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Check every entry's PDF under `root` against its manifest sha256; returns one message per failure. */
export function checkEntries(root: string, entries: readonly PublicationEntry[]): string[] {
  const errors: string[] = [];
  for (const e of entries) {
    const file = join(root, e.path);
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
  const text = readFileSync(manifestFile, "utf8");
  const { entries, rejected } = parseManifest(text);
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

/** Post-build guard: the manifest the site was built from and the PDFs in dist must agree. */
export function verifyDist(manifestFile: string, distDownloads: string): string[] {
  if (!existsSync(manifestFile)) return [];
  const { entries } = parseManifest(readFileSync(manifestFile, "utf8"));
  return checkEntries(distDownloads, entries);
}
