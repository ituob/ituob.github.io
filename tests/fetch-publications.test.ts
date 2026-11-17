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

const run = (id: number, created: string) => ({
  id, event: "push", head_branch: "main", head_sha: "a".repeat(40), conclusion: "success",
  created_at: created, head_repository: { full_name: REPO },
});

/** A fake `gh` on PATH: serves canned runs/artifacts and "downloads" a prepared artifact dir. */
function harness(opts: { artifacts: Record<number, string[]>; tamper?: boolean }) {
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
  writeFileSync(data, JSON.stringify({ runs: [run(2, "2026-11-02T00:00:00Z"), run(1, "2026-11-01T00:00:00Z")], ...opts }));
  const fake = join(bin, "gh");
  writeFileSync(fake, `#!/usr/bin/env node
const fs = require("fs");
const d = JSON.parse(fs.readFileSync(${JSON.stringify(data)}, "utf8"));
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(dir, "calls.log"))}, a.join(" ") + "\\n");
if (a[0] === "api" && /\\/runs\\?/.test(a[1])) console.log(JSON.stringify({ workflow_runs: d.runs }));
else if (a[0] === "api") {
  const id = a[1].match(/runs\\/(\\d+)\\/artifacts/)[1];
  console.log(JSON.stringify({ artifacts: (d.artifacts[id] || []).map((name) => ({ name, expired: false })) }));
} else if (a[0] === "run" && a[1] === "download") {
  fs.cpSync(${JSON.stringify(art)}, a[a.indexOf("-D") + 1], { recursive: true });
} else process.exit(2);
`);
  chmodSync(fake, 0o755);
  const cwd = join(dir, "site");
  mkdirSync(cwd);
  const r = spawnSync(process.execPath, ["--experimental-strip-types", script, "fetch"], {
    cwd, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: "x" },
  });
  return { r, cwd, calls: join(dir, "calls.log") };
}

test("no run has a publications artifact: exit 0, loud warning, empty listing", () => {
  const { r, cwd } = harness({ artifacts: { 1: ["pdf-pilot-X"], 2: ["pdf-pilot-Y"] } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /WARNING.*no successful.*"publications" artifact/);
  assert.equal(existsSync(join(cwd, "src/data/publications-manifest.json")), false);
});

test("the newest run that has the artifact is used, older ones are skipped", () => {
  const { r, cwd, calls } = harness({ artifacts: { 1: ["publications"], 2: ["pdf-pilot-Y"] } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 PDFs verified and placed from .* run 1 /);
  assert.equal(existsSync(join(cwd, "public/downloads/a.pdf")), true);
  assert.match(readFileSync(calls, "utf8"), /run download 1 /);
});

test("a corrupt artifact still fails the build", () => {
  const { r } = harness({ artifacts: { 2: ["publications"] }, tamper: true });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /FAILED/);
});
