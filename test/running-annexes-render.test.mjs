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
