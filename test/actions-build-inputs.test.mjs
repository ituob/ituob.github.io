import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { capture, finalize } from "./actions-build-inputs.mjs";

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "actions-build-inputs-"));
  try {
    mkdirSync(join(root, "src"));
    for (const name of ["src/page.astro", "package-lock.json", "astro.config.mjs", "register-snapshots.integration.mjs"]) {
      writeFileSync(join(root, name), "original");
    }
    const receipt = join(root, "build_inputs.json");
    capture(root, receipt, "source-head");
    run(root, receipt);
  } finally {
    rmSync(root, { recursive: true });
  }
}

test("an unchanged completed build retains the exact source revision and hashes", () => fixture((root, receipt) => {
  finalize(root, receipt);
  const build = JSON.parse(readFileSync(receipt, "utf8"));
  assert.equal(build.source_head, "source-head");
  assert.equal(build.status, "success");
  assert.equal(Object.keys(build.source_sha256).length, 4);
  assert.ok(Date.parse(build.completed_at) >= Date.parse(build.started_at));
}));

test("changed source cannot receive a successful build receipt", () => fixture((root, receipt) => {
  writeFileSync(join(root, "src/page.astro"), "changed during build");
  assert.throws(() => finalize(root, receipt), /Build inputs changed/);
  assert.notEqual(JSON.parse(readFileSync(receipt, "utf8")).status, "success");
}));

test("a new source file during the build also invalidates its receipt", () => fixture((root, receipt) => {
  writeFileSync(join(root, "src/extra.astro"), "new route");
  assert.throws(() => finalize(root, receipt), /Build inputs changed/);
  assert.notEqual(JSON.parse(readFileSync(receipt, "utf8")).status, "success");
}));
