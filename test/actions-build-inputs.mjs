import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function sourceHashes(root) {
  const paths = readdirSync(join(root, "src"), { recursive: true })
    .map(path => `src/${path}`).filter(path => statSync(join(root, path)).isFile());
  paths.push("package-lock.json", "astro.config.mjs", "register-snapshots.integration.mjs");
  return Object.fromEntries(paths.sort().map(path => [path,
    createHash("sha256").update(readFileSync(join(root, path))).digest("hex")]));
}

export function capture(root, receipt, head) {
  writeFileSync(receipt, JSON.stringify({
    source_head: head, started_at: new Date().toISOString(), audited_routes: 429,
    source_sha256: sourceHashes(root),
  }, null, 2) + "\n");
}

// Called only after the build command exits successfully.
export function finalize(root, receipt) {
  const build = JSON.parse(readFileSync(receipt, "utf8"));
  assert.deepEqual(sourceHashes(root), build.source_sha256, "Build inputs changed");
  build.completed_at = new Date().toISOString();
  build.status = "success";
  writeFileSync(receipt, JSON.stringify(build, null, 2) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, receipt] = process.argv.slice(2);
  assert.ok(receipt && ["capture", "finalize"].includes(mode), "usage: actions-build-inputs.mjs capture|finalize RECEIPT");
  const root = process.cwd();
  if (mode === "capture") {
    capture(root, receipt, execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim());
  } else {
    finalize(root, receipt);
  }
}
