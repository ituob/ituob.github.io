import { afterEach, describe, expect, it } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "register-assets-"));
  temporaryRoots.push(root);
  const integrationPath = join(root, "register-snapshots.integration.mjs");
  copyFileSync(join(projectRoot, "register-snapshots.integration.mjs"), integrationPath);
  for (const [name, contents] of Object.entries(files)) {
    const target = join(root, "data", "snapshots", name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  const { default: integration } = await import(/* @vite-ignore */ pathToFileURL(integrationPath).href);
  return { root, integration: integration() };
}

describe("register snapshot assets", () => {
  it("publishes exact current snapshots at the worker asset URLs and preserves existing output", async () => {
    const current = '{"active_entries":[{"key":"1","name":"One"}],"lapsed_keys":["2"]}\n';
    const { root, integration } = await fixture({
      "e164-cc/manifest.json": '{"touched_issues":[1000]}',
      "e164-cc/current.json": current,
      "e164-cc/1000.json": '{"historical":true}',
      "e212-mnc/manifest.json": '{"touched_issues":[]}',
      "e212-mnc/current.json": '{"active_entries":[]}',
      "missing-current/manifest.json": '{"touched_issues":[]}',
    });
    const output = join(root, "custom-output");
    mkdirSync(output);
    writeFileSync(join(output, "index.html"), "existing page");

    await integration.hooks["astro:build:done"]?.({ dir: pathToFileURL(`${output}/`) });

    expect(readFileSync(join(output, "data/snapshots/e164-cc/current.json"), "utf8")).toBe(current);
    expect(readFileSync(join(output, "data/snapshots/e212-mnc/current.json"), "utf8")).toBe('{"active_entries":[]}');
    expect(readFileSync(join(output, "index.html"), "utf8")).toBe("existing page");
    expect(existsSync(join(output, "data/snapshots/e164-cc/1000.json"))).toBe(false);
    expect(existsSync(join(output, "data/snapshots/e164-cc/manifest.json"))).toBe(false);
    expect(existsSync(join(output, "data/snapshots/missing-current/current.json"))).toBe(false);
  });

  it("allows builds without snapshot data", async () => {
    const { root, integration } = await fixture({});
    const output = join(root, "dist");
    await integration.hooks["astro:build:done"]?.({ dir: pathToFileURL(`${output}/`) });
    expect(existsSync(join(output, "data/snapshots"))).toBe(false);
  });
});
