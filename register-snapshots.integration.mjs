/**
 * Astro integration: enumerates available register snapshots and
 * publishes their slugs + ob_issue numbers to globalThis so the
 * /registers/[slug] and /registers/[slug]/at/[ob_issue] pages can
 * generate static paths at build time.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const projectRoot = dirname(fileURLToPath(import.meta.url));
const snapshotRoot = resolve(projectRoot, "data", "snapshots");

/** @type {{ params: { slug: string } }[]} */
const slugPaths = [];
/** @type {{ params: { slug: string; ob_issue: string } }[]} */
const atPaths = [];

if (existsSync(snapshotRoot)) {
  for (const slug of readdirSync(snapshotRoot)) {
    const manifestPath = join(snapshotRoot, slug, "manifest.json");
    if (!existsSync(manifestPath)) continue;

    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    } catch {
      continue;
    }

    slugPaths.push({ params: { slug } });
    for (const issue of manifest.touched_issues) {
      atPaths.push({ params: { slug, ob_issue: String(issue) } });
    }
  }
}

globalThis.__REGISTER_SNAPSHOT_SLUGS__ = slugPaths;
globalThis.__REGISTER_SNAPSHOT_AT_PATHS__ = atPaths;

console.log(`[register-snapshots] ${slugPaths.length} register pages, ${atPaths.length} point-in-time pages`);

export default function registerSnapshotsIntegration() {
  return {
    name: "register-snapshots",
    hooks: {
      "astro:config:setup"() {
        // Paths are already set on globalThis above.
      },
    },
  };
}
