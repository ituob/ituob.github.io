# Deferred annex chronology regressions

These are the reproduction specs written for the pinned-corpus QA request.
They are preserved here with the deferred feature, rather than run as tests of
the retained PR. The PM requires the printed OB and date policy to agree before
shipping this change. In particular, the pinned E.212 timestamp renders 14
November while the printed position is 15 November. The expectations below
record that QA reproduction; they are not an approved date policy for a future
implementation. A follow-up must establish corrected fixtures/expectations from
the primary sources before restoring these tests.

The original loader produced four chronology failures and two preservation
passes; the exploratory latest-record patch passed all six. That patch has now
been removed under the PM's fallback. The active evidence specs verify that the
retained loader exactly matches the source of the successful build and score.

## `test/running-annexes.test.mjs`

```js
import assert from "node:assert/strict";
import { extname } from "node:path";
import { registerHooks } from "node:module";
import { test } from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier.startsWith(".") && !extname(specifier) ? `${specifier}.ts` : specifier, context);
  },
});
const { computeRunningAnnexes } = await import("../src/lib/loaders.ts");
const { formatObDate } = await import("../src/lib/ob-date.ts");
const publication = (issue, id) => computeRunningAnnexes(issue).find((entry) => entry.pubId === id);

test("pinned OB 1296 lists the E.212 MNC annex at OB 1280 with that event's position date", () => {
  const entry = publication(1296, "E212_MNC");
  assert.equal(entry?.annexed_in, 1280);
  assert.equal(entry?.position_on, "2023-11-14T23:00:00.000Z");
  assert.equal(formatObDate(entry.position_on), "14.XI.2023");
});

test("a second re-annexed publication uses its latest annex, and the list remains newest first", () => {
  const entries = computeRunningAnnexes(1296);
  const entry = publication(1296, "E118_IIN");
  assert.equal(entry?.annexed_in, 1283);
  assert.equal(formatObDate(entry.position_on), "31.XII.2023");
  assert.ok(entries.findIndex((item) => item.pubId === "E118_IIN") < entries.findIndex((item) => item.pubId === "E212_MNC"));
});

test("historical issues keep their then-current annex and never inherit a future event", () => {
  for (const issue of [1162, 1279]) {
    const entry = publication(issue, "E212_MNC");
    assert.equal(entry?.annexed_in, 1162);
    assert.equal(formatObDate(entry.position_on), "15.XII.2018");
    assert.ok(computeRunningAnnexes(issue).every((item) => item.annexed_in <= issue));
  }
});

test("the separate E.212 country-code publication keeps its own OB 1117 row", () => {
  const entry = publication(1296, "E212_ICC");
  assert.equal(entry?.annexed_in, 1117);
  assert.equal(formatObDate(entry.position_on), "1.II.2017");
});
```

## `test/running-annexes-render.test.mjs`

```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transform } from "@astrojs/compiler-rs";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { test } from "node:test";

// Compile the actual component in memory against the pinned corpus. This
// exercises its HTML without requiring a full-site build or stale dist files.
const root = fileURLToPath(new URL("../", import.meta.url));
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("~/")) return nextResolve(pathToFileURL(join(root, "src", `${specifier.slice(2)}.ts`)).href, context);
    if (specifier.startsWith("astro/")) return nextResolve(specifier, { ...context, parentURL: import.meta.url });
    return nextResolve(specifier.startsWith(".") && !extname(specifier) ? `${specifier}.ts` : specifier, context);
  },
});
const { loadIssue } = await import("../src/lib/loaders.ts");
const filename = join(root, "src/components/RunningAnnexes.astro");
const compiled = transform(readFileSync(filename, "utf8"), {
  filename, internalURL: "astro/compiler-runtime", resolvePath: (specifier) => specifier, resultScopedSlot: true,
});
const component = await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString("base64")}`);
const container = await AstroContainer.create();
const html = await container.renderToString(component.default, { props: { issue: loadIssue(1296) } });
const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((match) => match[1]);
const rowFor = (slug) => rows.find((row) => row.includes(`href="/datasets/${slug}/"`));

test("OB 1296's E.212 MNC row prints OB 1280 and 14.XI.2023", () => {
  assert.ok(html.includes("Lists have been published"), "running annexes section exists");
  const row = rowFor("e212-mnc");
  assert.ok(row, "MNC publication has its own row");
  assert.ok(row.includes('href="/issues/1280/"'), "links to latest annex OB 1280");
  assert.ok(row.includes("position on 14.XI.2023"), "prints the latest event's date");
  assert.ok(row.includes("Mobile Network Codes"), "checks MNC, not the country-code list");
});

test("OB 1296 retains the distinct country-code publication at OB 1117", () => {
  const row = rowFor("e212-icc");
  assert.ok(row, "country-code publication remains separate");
  assert.ok(row.includes('href="/issues/1117/"'));
  assert.ok(row.includes("position on 1.II.2017"));
});
```

