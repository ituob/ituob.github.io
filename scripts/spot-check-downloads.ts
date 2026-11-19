/**
 * Downloads spot-check CLI (ituob.github.io#112).
 *
 *   node --experimental-strip-types scripts/spot-check-downloads.ts [--dist dist | --base-url https://host]
 *        [--sample 5|all] [--manifest src/data/publications-manifest.json] [--report-dir spot-check-report]
 *
 * Verifies N manifest entries against the built site (default) or a live host
 * (staging / production), writes spot-check-report/report.md + report.json and
 * appends the table to $GITHUB_STEP_SUMMARY. Exit 1 on failed or rejected entries. An empty
 * or absent manifest passes with a note unless PUBLICATIONS_REQUIRED=true.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { distSource, httpSource, pickEntries, renderReport, spotCheck } from "../src/lib/downloads-spot-check.ts";
import { parseManifest } from "../src/lib/publications.ts";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

async function main(): Promise<number> {
  const root = process.cwd();
  const manifestPath = resolve(root, arg("manifest", "src/data/publications-manifest.json"));
  const baseUrl = arg("base-url", "");
  const target = baseUrl || `dist (${resolve(root, arg("dist", "dist"))})`;
  const reportDir = resolve(root, arg("report-dir", "spot-check-report"));
  const sampleArg = arg("sample", "5");
  mkdirSync(reportDir, { recursive: true });

  const { entries, rejected } = existsSync(manifestPath)
    ? parseManifest(readFileSync(manifestPath, "utf8")) : { entries: [], rejected: [] };
  const total = entries.length + rejected.length;
  const publish = (md: string, json: unknown) => {
    writeFileSync(resolve(reportDir, "report.md"), md);
    writeFileSync(resolve(reportDir, "report.json"), JSON.stringify(json, null, 2) + "\n");
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
    console.log(md);
  };

  if (total === 0) {
    const required = process.env.PUBLICATIONS_REQUIRED === "true";
    publish(`## Downloads spot-check: ${required ? "FAIL" : "NOTHING TO CHECK"}\n\n- Target: ${target}\n- The manifest lists no publications.\n`, { target, total, checked: 0, rejected, ok: !required });
    return required ? 1 : 0;
  }

  const sample = entries.length === 0 ? [] : pickEntries(entries, sampleArg === "all" ? entries.length : Number(sampleArg));
  const source = baseUrl ? httpSource(baseUrl) : distSource(resolve(root, arg("dist", "dist")));
  const results = await spotCheck(entries, sample, source);
  const at = new Date().toISOString();
  const ok = rejected.length === 0 && results.every((r) => r.ok);
  publish(renderReport(results, { target, total, at, rejected }), { target, at, total, checked: results.length, rejected, ok, results });
  return ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`[spot-check] FAILED: ${(err as Error).message}`);
    process.exit(1);
  },
);
