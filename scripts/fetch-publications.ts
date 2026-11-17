/**
 * Build step: fetch the spd PDF artifact and place it (ituob.github.io#112, W5).
 *
 *   node --experimental-strip-types scripts/fetch-publications.ts fetch
 *   node --experimental-strip-types scripts/fetch-publications.ts verify-dist
 *
 * `fetch` finds the newest live artifact of the producer workflow on the
 * producer's default branch (only push / workflow_dispatch runs whose head repository is the producer itself;
 * never a pull-request or fork run: those are unreviewed),
 * downloads its artifact with `gh`, verifies the checksums and places the files
 * (public/downloads for Astro to copy into dist, manifest into src/data).
 * Its producer run must have succeeded; none yet: exit 0 with an empty listing, unless
 * PUBLICATIONS_REQUIRED=true (which also fails on an empty manifest). A checksum
 * failure, a rejected manifest entry or a symlink always exits 1.
 * `verify-dist` re-checks dist/downloads against the manifest after the build.
 *
 * Env: GH_TOKEN (required by gh; the workflow's GITHUB_TOKEN suffices, the
 * producer repo is public), PUBLICATIONS_REPO, PUBLICATIONS_WORKFLOW,
 * PUBLICATIONS_ARTIFACT, PUBLICATIONS_BRANCH.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { selectRunWithArtifact, verifyAndPlace, verifyDist, type ArtifactInfo, type RunInfo } from "../src/lib/publications-place.ts";

const root = process.cwd();
const env = process.env;
const REPO = env.PUBLICATIONS_REPO || "ituob/service-publications-docs";
const WORKFLOW = env.PUBLICATIONS_WORKFLOW || "pdf.yml";
const ARTIFACT = env.PUBLICATIONS_ARTIFACT || "publications";
const BRANCH = env.PUBLICATIONS_BRANCH || "main";
const REQUIRED = env.PUBLICATIONS_REQUIRED === "true";
const MANIFEST_OUT = resolve(root, "src/data/publications-manifest.json");
const DOWNLOADS = resolve(root, "public/downloads");

const gh = (args: string[]) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** Validate the JSON envelope before reading endpoint-specific fields. */
function apiObject(endpoint: string): Record<string, unknown> {
  const body = gh(["api", endpoint]);
  let response: unknown;
  try {
    response = JSON.parse(body);
  } catch {
    throw new Error(`Invalid GitHub API response for ${endpoint}: expected a JSON object`);
  }
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new Error(`Invalid GitHub API response for ${endpoint}: expected a JSON object`);
  }
  return response as Record<string, unknown>;
}

function none(why: string): never {
  const msg = `[publications] ${why}`;
  if (REQUIRED) {
    console.error(`${msg} (PUBLICATIONS_REQUIRED=true)`);
    process.exit(1);
  }
  console.log(`${msg}; building with an empty downloads listing`);
  process.exit(0);
}

function fetchAndPlace(): void {
  // Search artifacts directly: a live publication can outlast arbitrarily many runs.
  const artifacts: ArtifactInfo[] = [];
  for (let page = 1; ; page++) {
    const endpoint = `repos/${REPO}/actions/artifacts?name=${encodeURIComponent(ARTIFACT)}&per_page=100&page=${page}`;
    const response = apiObject(endpoint);
    if (!Array.isArray(response.artifacts)) {
      throw new Error(`Invalid GitHub API response for ${endpoint}: expected artifacts to be an array`);
    }
    artifacts.push(...response.artifacts);
    if (response.artifacts.length < 100) break;
  }
  if (artifacts.length === 0) none(`WARNING: no successful push/workflow_dispatch ${WORKFLOW} run on ${REPO}@${BRANCH} has a "${ARTIFACT}" artifact yet`);
  const workflow = apiObject(`repos/${REPO}/actions/workflows/${encodeURIComponent(WORKFLOW)}`);
  if (!Number.isSafeInteger(workflow.id)) throw new Error("Invalid GitHub API workflow response: expected a workflow id");
  const run = selectRunWithArtifact(artifacts, REPO, BRANCH, ARTIFACT, workflow.id as number, (id) => {
    const response = apiObject(`repos/${REPO}/actions/runs/${id}`);
    if (response.id !== id || typeof response.head_sha !== "string") {
      throw new Error(`Invalid GitHub API run response for run ${id}: expected run id and head_sha`);
    }
    return response as unknown as RunInfo;
  });
  if (!run) none(`WARNING: no successful push/workflow_dispatch ${WORKFLOW} run on ${REPO}@${BRANCH} has a "${ARTIFACT}" artifact yet`);

  const tmp = mkdtempSync(join(tmpdir(), "publications-"));
  try {
    // The artifact was just listed as live, so a download failure is real.
    gh(["run", "download", String(run.id), "-R", REPO, "-n", ARTIFACT, "-D", tmp]);
    if (readdirSync(tmp).length === 0) none(`artifact "${ARTIFACT}" of run ${run.id} is empty`);
    const { placed } = verifyAndPlace(tmp, DOWNLOADS, MANIFEST_OUT);
    if (placed.length === 0) none(`artifact "${ARTIFACT}" of run ${run.id} lists no publications`);
    console.log(`[publications] ${placed.length} PDFs verified and placed from ${REPO} run ${run.id} (${run.head_sha.slice(0, 7)})`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const cmd = process.argv[2];
try {
  if (cmd === "fetch") fetchAndPlace();
  else if (cmd === "verify-dist") {
    const errors = verifyDist(MANIFEST_OUT, resolve(root, "dist/downloads"));
    if (errors.length > 0) throw new Error(`dist/downloads does not match the manifest:\n  ${errors.join("\n  ")}`);
    console.log("[publications] dist/downloads matches the manifest");
  } else throw new Error("usage: fetch-publications.ts fetch|verify-dist");
} catch (err) {
  console.error(`[publications] FAILED: ${(err as Error).message}`);
  process.exit(1);
}
