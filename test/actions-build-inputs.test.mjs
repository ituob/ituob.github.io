import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { capture, finalize } from "./actions-build-inputs.mjs";

const workflow = JSON.parse(execFileSync(process.env.PARITY_RUBY ?? "ruby", [
  "-ryaml", "-rjson", "-e", "puts JSON.generate(YAML.load_file(ARGV.fetch(0)))",
  new URL("../.github/workflows/printed-labels-parity.yml", import.meta.url).pathname,
], { encoding: "utf8" }));

function failedBuild(root, stepName) {
  const job = workflow.jobs["page-parity"];
  const step = job.steps.find(step => step.name === stepName);
  const shell = step.shell ?? job.defaults?.run?.shell ?? workflow.defaults?.run?.shell;
  assert.ok(shell === undefined || shell === "bash", "model the Actions bash invocation explicitly");
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, "parity-report"));
  const driver = join(root, "node-driver.mjs");
  writeFileSync(driver, `
    import {capture, finalize} from ${JSON.stringify(new URL("./actions-build-inputs.mjs", import.meta.url).href)};
    const [, mode, receipt] = process.argv.slice(2);
    if (mode === 'capture') capture(process.cwd(), receipt, 'source-head');
    else finalize(process.cwd(), receipt);
  `);
  const scripts = {
    npm: 'if [ "$1" = run ] && [ "$2" = build ]; then echo "partial Astro output"; exit 37; fi\n',
    bundle: 'echo "partial Jekyll output"; exit 41\n',
    node: `exec "${process.execPath}" "${driver}" "$@"\n`,
  };
  for (const [name, contents] of Object.entries(scripts)) {
    writeFileSync(join(bin, name), `#!/bin/bash\n${contents}`);
    chmodSync(join(bin, name), 0o755);
  }
  const script = join(root, "step.sh");
  writeFileSync(script, `${step.run}\nprintf scored > "$RUNNER_TEMP/scored"\n`);
  // GitHub's unspecified bash uses -e; explicit `shell: bash` adds pipefail.
  const flags = shell === "bash" ? ["--noprofile", "--norc", "-e", "-o", "pipefail"] : ["-e"];
  return spawnSync("/bin/bash", [...flags, script], {
    cwd: root, encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: root, AUDIT_CONFIG: "unused" },
  });
}

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

test("a failed Astro pipeline preserves its error and cannot finalize a success receipt or score", () => fixture((root) => {
  const result = failedBuild(root, "Build full Astro site and record its inputs");
  const build = JSON.parse(readFileSync(join(root, "parity-report/build_inputs.json"), "utf8"));
  assert.notEqual(build.status, "success", "a failed build must not be finalized");
  assert.equal(result.status, 37, result.stdout + result.stderr);
  assert.equal(existsSync(join(root, "scored")), false);
  assert.match(readFileSync(join(root, "astro-build.log"), "utf8"), /partial Astro output/);
}));

test("a failed Jekyll pipeline preserves its error and cannot proceed to scoring", () => fixture((root) => {
  const result = failedBuild(root, "Build Jekyll reference");
  assert.equal(result.status, 41, result.stdout + result.stderr);
  assert.equal(existsSync(join(root, "scored")), false);
  assert.match(readFileSync(join(root, "jekyll-build.log"), "utf8"), /partial Jekyll output/);
}));
