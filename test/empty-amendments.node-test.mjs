import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { registerHooks } from "node:module";
import { test } from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier.startsWith(".") && !/\.[cm]?js$|\.ts$/.test(specifier) ? `${specifier}.ts` : specifier, context);
  },
});

test("loadIssue preserves only truly empty source amendment headers", async () => {
  const repo = resolve(".");
  const fixture = mkdtempSync(join(tmpdir(), "ituob-empty-amendments-"));
  try {
    cpSync(join(repo, "src/lib"), join(fixture, "src/lib"), { recursive: true });
    symlinkSync(join(repo, "node_modules"), join(fixture, "node_modules"), "dir");
    const meta = "id: 1\npublication_date: '2018-01-01'\ncutoff_date: '2018-01-01'\nissn: '0000-0000'\nlanguages: {}\nauthors: []\n";
    for (const id of [1266, 1277, 1300]) {
      mkdirSync(join(fixture, "data-ob/ob-issues", String(id)), { recursive: true });
      writeFileSync(join(fixture, "data-ob/ob-issues", String(id), "meta.yaml"), meta.replace("id: 1", `id: ${id}`));
      const projected = join(fixture, "data-ob/ob-issues", String(id), "e212-mnc");
      if (id === 1300) {
        mkdirSync(projected, { recursive: true });
        writeFileSync(join(projected, "001-ADD.yaml"), "type: ADD\nob_issue_no: '1300'\ndata:\n  entries:\n    - networks: Preserved operator\n");
      }
      mkdirSync(join(fixture, "data/issues", String(id)), { recursive: true });
      writeFileSync(join(fixture, "data/issues", String(id), "amendments.yaml"), `messages:\n  - type: amendment\n    target:\n      publication: E212_MNC\n    contents: {}\n    datasetChanges:\n      main:\n        contents: []\n      et:\n        contents: []\n  - type: amendment\n    target:\n      publication: E118_IIN\n    contents:\n      en: nonempty\n    datasetChanges:\n      main:\n        contents: []\n  - type: amendment\n    target:\n      publication: E164_CC\n    contents: {}\n    datasetChanges:\n      main:\n        contents:\n          - invented row\n`);
    }

    const { loadIssue } = await import(join(fixture, "src/lib/loaders.ts"));
    for (const id of [1266, 1277]) {
      const loaded = loadIssue(id);
      assert.ok(loaded);
      assert.deepEqual(loaded.amendments.placeholder["e212-mnc"], {
        _class: "PlaceholderAmendment",
        ob_issue_no: String(id),
      });
      assert.deepEqual(loaded.amendments.structured, {}, "no dataset rows are invented");
      assert.deepEqual(loaded.amendments.placeholder, { "e212-mnc": loaded.amendments.placeholder["e212-mnc"] });
    }
    const preserved = loadIssue(1300);
    assert.ok(preserved);
    assert.deepEqual(preserved.amendments.structured["e212-mnc"]?.map(({ seq }) => seq), [1]);
    assert.equal(preserved.amendments.structured["e212-mnc"]?.[0].data.entries[0].networks, "Preserved operator");
    assert.equal(preserved.amendments.placeholder["e212-mnc"], undefined, "source header does not override projected content");
    assert.equal(preserved.amendments.placeholder["e118-iin"], undefined, "nonempty source prose is not synthesized");
    assert.equal(preserved.amendments.placeholder["e164-cc"], undefined, "nonempty dataset changes are not synthesized");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
