import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve("scripts/fetch-publications.ts");
const REPO = "ituob/service-publications-docs";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const run = (id: number, created = "2026-11-01T00:00:00Z") => ({
  id, workflow_id: 42, event: "push", head_branch: "main", head_sha: "a".repeat(40), conclusion: "success",
  created_at: created, head_repository: { full_name: REPO } as { full_name: string } | null,
});
const artifact = (runId: number, created = "2026-11-01T00:00:00Z") => ({
  id: runId, name: "publications", expired: false, created_at: created,
  workflow_run: { id: runId } as { id: number } | null,
});
type Options = {
  artifacts: ReturnType<typeof artifact>[];
  runs?: ReturnType<typeof run>[];
  tamper?: boolean;
  collectionBody?: string;
  apiError?: string;
};

/** Both API generations are supported so regressions fail on behavior, not fake-gh incompatibility. */
function harness(opts: Options) {
  const dir = mkdtempSync(join(tmpdir(), "fetchpub-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const body = "%PDF-1.7 test";
  const art = join(dir, "art");
  mkdirSync(art);
  writeFileSync(join(art, "a.pdf"), opts.tamper ? "tampered" : body);
  writeFileSync(join(art, "manifest.json"), JSON.stringify({ publications: [{
    standard: "E.212", title: "T", edition_year: 2026, language: "en", as_of_issue: 1170,
    sha256: sha(body), status: "candidate", register_slugs: ["e212-mnc"], path: "a.pdf",
  }] }));
  const data = join(dir, "data.json");
  writeFileSync(data, JSON.stringify({ runs: [run(2, "2026-11-02T00:00:00Z"), run(1)], ...opts }));
  const fake = join(bin, "gh");
  writeFileSync(fake, `#!/usr/bin/env node
const fs = require("fs");
const d = JSON.parse(fs.readFileSync(${JSON.stringify(data)}, "utf8"));
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(dir, "calls.log"))}, a.join(" ") + "\\n");
if (a[0] === "api") {
  if (d.apiError) { console.error(d.apiError); process.exit(1); }
  const url = new URL(a[1], "https://api.github.com/");
  const path = url.pathname;
  const page = Number(url.searchParams.get("page") || 1);
  const perPage = Number(url.searchParams.get("per_page") || 30);
  const send = (value) => console.log(JSON.stringify(value));
  const collection = (value) => d.collectionBody === undefined ? send(value) : console.log(d.collectionBody);
  if (/\\/workflows\\/pdf.yml$/.test(path)) send({ id: 42 });
  else if (/\\/workflows\\/pdf.yml\\/runs$/.test(path)) collection({ workflow_runs: d.runs.slice((page - 1) * perPage, page * perPage) });
  else if (/\\/runs\\/\\d+\\/artifacts$/.test(path)) {
    const id = Number(path.match(/runs\\/(\\d+)/)[1]);
    collection({ artifacts: d.artifacts.filter((art) => art.workflow_run?.id === id) });
  } else if (/\\/actions\\/artifacts$/.test(path)) {
    collection({ artifacts: d.artifacts.slice((page - 1) * perPage, page * perPage) });
  } else if (/\\/runs\\/\\d+$/.test(path)) {
    const id = Number(path.match(/runs\\/(\\d+)/)[1]);
    const run = d.runs.find((run) => run.id === id);
    if (!run) { console.error("Unknown run " + id); process.exit(2); }
    send(run);
  } else { console.error("Unknown API endpoint " + a[1]); process.exit(2); }
} else if (a[0] === "run" && a[1] === "download") {
  fs.cpSync(${JSON.stringify(art)}, a[a.indexOf("-D") + 1], { recursive: true });
} else process.exit(2);
`);
  chmodSync(fake, 0o755);
  const cwd = join(dir, "site");
  mkdirSync(cwd);
  const r = spawnSync(process.execPath, ["--experimental-strip-types", script, "fetch"], {
    cwd, encoding: "utf8", env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: "x",
      PUBLICATIONS_REPO: REPO, PUBLICATIONS_WORKFLOW: "pdf.yml", PUBLICATIONS_ARTIFACT: "publications",
      PUBLICATIONS_BRANCH: "main", PUBLICATIONS_REQUIRED: "false",
    },
  });
  return { r, cwd, calls: readFileSync(join(dir, "calls.log"), "utf8") };
}

function assertDownloaded(result: ReturnType<typeof harness>, id: number) {
  const { r, cwd, calls } = result;
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`1 PDFs verified and placed from .* run ${id} `));
  assert.equal(readFileSync(join(cwd, "public/downloads/a.pdf"), "utf8"), "%PDF-1.7 test");
  assert.equal(JSON.parse(readFileSync(join(cwd, "src/data/publications-manifest.json"), "utf8")).publications.length, 1);
  const downloads = calls.split("\n").filter((call) => call.startsWith("run download"));
  assert.equal(downloads.length, 1);
  assert.ok(downloads[0]!.startsWith(`run download ${id} -R ${REPO} -n publications -D `));
}

function assertNoDownload(result: ReturnType<typeof harness>) {
  assert.doesNotMatch(result.calls, /run download/);
  assert.equal(existsSync(join(result.cwd, "public/downloads/a.pdf")), false);
  assert.equal(existsSync(join(result.cwd, "src/data/publications-manifest.json")), false);
}

test("no run has a publications artifact: exit 0, loud warning, empty listing", () => {
  const result = harness({ artifacts: [{ ...artifact(1), name: "pdf-pilot-X" }, { ...artifact(2), name: "pdf-pilot-Y" }] });
  assert.equal(result.r.status, 0, result.r.stderr);
  assert.match(result.r.stdout, /WARNING.*no successful.*"publications" artifact/);
  assertNoDownload(result);
});

test("the newest run with a publications artifact is used when newer runs have other artifacts", () => {
  assertDownloaded(harness({ artifacts: [artifact(1), { ...artifact(2), name: "pdf-pilot-Y" }] }), 1);
});

test("a live artifact is found even when its run is older than twenty recent runs", () => {
  const runs = Array.from({ length: 25 }, (_, i) => run(25 - i, `2026-11-${String(25 - i).padStart(2, "0")}T00:00:00Z`));
  assertDownloaded(harness({ runs, artifacts: [artifact(1)] }), 1);
});

test("selection follows artifact creation time rather than run creation time or API order", () => {
  assertDownloaded(harness({ artifacts: [artifact(2), artifact(1, "2026-11-03T00:00:00Z")] }), 1);
});

test("an invalid artifact creation date sorts behind a valid creation date", () => {
  assertDownloaded(harness({ artifacts: [artifact(2, "invalid"), artifact(1)] }), 1);
});

test("artifact pagination includes the newest candidate on page two", () => {
  const artifacts = Array.from({ length: 100 }, (_, i) => ({ ...artifact(2), id: 100 + i }));
  artifacts.push(artifact(1, "2026-11-03T00:00:00Z"));
  const result = harness({ artifacts });
  assertDownloaded(result, 1);
  assert.match(result.calls, /actions\/artifacts\?name=publications&per_page=100&page=2/);
});

const untrusted = [
  ["fork", { head_repository: { full_name: "evil/fork" } }],
  ["pull request", { event: "pull_request" }],
  ["missing head repository", { head_repository: null }],
  ["wrong workflow", { workflow_id: 99 }],
  ["failed conclusion", { conclusion: "failure" }],
  ["other branch", { head_branch: "other" }],
] as const;
for (const [reason, overrides] of untrusted) {
  test(`a newer artifact from a run with ${reason} cannot displace a trusted artifact`, () => {
    assertDownloaded(harness({
      runs: [{ ...run(2, "2026-11-02T00:00:00Z"), ...overrides }, run(1)],
      artifacts: [artifact(2, "2026-11-03T00:00:00Z"), artifact(1)],
    }), 1);
  });
}

test("workflow_dispatch from the producer main branch remains trusted", () => {
  assertDownloaded(harness({ runs: [{ ...run(1), event: "workflow_dispatch" }], artifacts: [artifact(1)] }), 1);
});

test("a newer successful main workflow_dispatch subset artifact cannot displace the older full catalog", () => {
  assertDownloaded(harness({
    runs: [{ ...run(2, "2026-11-02T00:00:00Z"), event: "workflow_dispatch" }, run(1)],
    artifacts: [{ ...artifact(2, "2026-11-02T00:00:00Z"), name: "publications-subset" }, artifact(1)],
  }), 1);
});

test("a subset-only artifact is not downloaded as the full catalog", () => {
  const result = harness({
    runs: [{ ...run(2, "2026-11-02T00:00:00Z"), event: "workflow_dispatch" }, run(1)],
    artifacts: [{ ...artifact(2, "2026-11-02T00:00:00Z"), name: "publications-subset" }],
  });
  assert.equal(result.r.status, 0, result.r.stderr);
  assert.match(result.r.stdout, /WARNING.*no successful.*"publications" artifact/);
  assertNoDownload(result);
});

test("expired artifacts cannot displace a live older artifact", () => {
  assertDownloaded(harness({ artifacts: [{ ...artifact(2, "2026-11-03T00:00:00Z"), expired: true }, artifact(1)] }), 1);
});

test("an artifact without a workflow run is ignored", () => {
  assertDownloaded(harness({ artifacts: [{ ...artifact(2, "2026-11-03T00:00:00Z"), workflow_run: null }, artifact(1)] }), 1);
});

for (const body of ['{"message":"API rate limit exceeded"}', '{"workflow_runs":null}', '{"artifacts":null}', 'not JSON']) {
  test(`malformed artifact collection ${body} fails with an API diagnostic`, () => {
    const result = harness({ artifacts: [artifact(1)], collectionBody: body });
    assert.equal(result.r.status, 1);
    assert.match(result.r.stderr, /FAILED.*Invalid GitHub API response/i);
    assert.match(result.r.stderr, /actions\/artifacts/);
    assertNoDownload(result);
  });
}

test("a GitHub API failure fails the build without placing files", () => {
  const result = harness({ artifacts: [artifact(1)], apiError: "HTTP 503: temporarily unavailable" });
  assert.equal(result.r.status, 1);
  assert.match(result.r.stderr, /FAILED/);
  assert.match(result.r.stderr, /HTTP 503/);
  assertNoDownload(result);
});

test("a corrupt artifact still fails the build", () => {
  const { r, cwd } = harness({ artifacts: [artifact(2)], tamper: true });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /FAILED/);
  assert.equal(existsSync(join(cwd, "src/data/publications-manifest.json")), false);
});
