import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

const scopes = JSON.parse(readFileSync(new URL("../src/lib/legacy-archive-scopes.json", import.meta.url), "utf8"));
const routes = JSON.parse(readFileSync(new URL("../src/lib/legacy-archive-routes.json", import.meta.url), "utf8"));
const find = (old: string) => scopes.find((scope: { old_url: string }) => scope.old_url === old);

test("every legacy archive has a distinct scoped destination and source membership", () => {
  assert.equal(scopes.length, 299);
  assert.equal(Object.keys(routes).length, scopes.length);
  assert.equal(new Set(Object.values(routes)).size, scopes.length);
  for (const scope of scopes) {
    assert.equal(routes[scope.old_url], scope.new_route);
    assert.ok(scope.issueIds.length > 0);
    assert.equal(new Set(scope.issueIds).size, scope.issueIds.length);
    if (scope.kind === "recommendation") {
      assert.equal(scope.new_route, `/recommendations/${scope.code}/years/${scope.year}/`);
    } else {
      assert.equal(scope.new_route, `/registers/${scope.slug}/editions/${scope.editionToken}/` + (scope.year ? `years/${scope.year}/` : ""));
    }
  }
});

test("recommendation years retain their original source issues", () => {
  const scope = find("/messages/complement-to-itu-t-r E.118/2010/");
  assert.equal(scope.new_route, "/recommendations/E.118/years/2010/");
  assert.deepEqual(scope.issueIds, [970, 969, 964, 962, 961, 960, 956]);
});

test("publication year and edition stay separate from other editions and latest year", () => {
  const printed = find("/messages/amending-sp E164_CC (2016-12-15)/2017/");
  assert.deepEqual(printed.issueIds, [1130, 1126, 1124, 1120]);
  const utcYear = find("/messages/amending-sp E164_CC (2016-11-14 23:00:00 UTC)/2022/");
  const utcLatest = find("/messages/amending-sp E164_CC (2016-11-14 23:00:00 UTC)/");
  assert.deepEqual(utcYear.issueIds, [1258, 1257, 1252, 1242, 1240, 1238, 1236, 1235]);
  assert.deepEqual(utcLatest.issueIds, [1262, 1260]);
  assert.notEqual(printed.new_route, utcYear.new_route);
  assert.notEqual(utcYear.new_route, utcLatest.new_route);
});

test("F.32 and Bureaufax archives retain separate source content", () => {
  assert.deepEqual(find("/messages/amending-sp BUREAUFAX (-)/").issueIds, [1061]);
  assert.deepEqual(find("/messages/amending-sp F32_TDI (-)/").issueIds, [965, 963, 960, 959, 958, 957]);
  assert.deepEqual(find("/messages/amending-sp F32_TDI (2011-04-15)/2011/").issueIds, [988]);
  assert.deepEqual(find("/messages/amending-sp F32_TDI (2011-04-15)/").issueIds, [1017, 1013, 1004, 1000]);
  assert.deepEqual(find("/messages/amending-sp F32_TDI (2011-05-15 00:00:00 UTC)/").issueIds, [1148]);
});

test("every recorded source membership matches production HTML articles", () => {
  for (const scope of scopes) {
    const file = scope.old_url.slice(1) + "index.html";
    const html = execFileSync("git", ["show", `8ef2eb431183bdb1257c632d340ee3476169a265:${file}`], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    const ids = new Set<number>();
    for (const article of html.matchAll(/<article\b[\s\S]*?<\/article>/g)) {
      const source = article[0].match(/<a\b(?=[^>]*\btitle="Link to this message")[^>]*\bhref="\/issues\/(\d+)-en\/#[^"]*"/);
      assert.ok(source, scope.old_url);
      ids.add(Number(source[1]));
    }
    assert.deepEqual(scope.issueIds, [...ids].sort((a, b) => b - a), scope.old_url);
  }
});
