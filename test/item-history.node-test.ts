import test from "node:test";
import assert from "node:assert/strict";
import { itemHistory, itemPath, itemRouteToken, listRegisterItems } from "../src/lib/item-history.ts";
import type { RegisterState } from "../src/lib/snapshots.ts";

const seed = { type: "SEED", ob_issue: 1000, identifier: { code: "__seed__" } } as const;
const change = { type: "MOD", ob_issue: 1170, identifier: { position: "7" } } as const;
const state: RegisterState = {
  slug: "mnc", at_ob_issue: 1170, entry_count: 1, lapsed_count: 1, deleted_count: 1,
  error_count: 0, active_entries: [{ code: "21604", name: "Current operator" }],
  lapsed_keys: ["lapsed / key"], deleted_keys: ["deleted key"], history: [seed, change],
  key_history: {
    "21604": [seed, change], "other row": [change],
    "lapsed / key": [seed, { type: "LIR", ob_issue: 1160, identifier: {} }],
    "deleted key": [seed, { type: "SUP", ob_issue: 1165, identifier: {} }],
  },
};

test("uses actual key history rather than printed position; preserves flat history", () => {
  assert.deepEqual(itemHistory(state, "21604"), [seed, change]);
  assert.equal(itemHistory(state, "7"), null);
  assert.deepEqual(itemHistory(state, "other row"), [change]);
  assert.deepEqual(state.history, [seed, change]);
  assert.equal(itemHistory(state, "toString"), null);
});

test("indexes current, lapsed and deleted items with their own history", () => {
  const items = listRegisterItems(state, "code");
  assert.deepEqual(items.map(({ key, status }) => [key, status]), [
    ["21604", "active"], ["deleted key", "deleted"], ["lapsed / key", "lapsed"], ["other row", "historical"],
  ]);
  assert.equal(items[0]?.entry?.name, "Current operator");
  assert.equal(itemHistory(state, "lapsed / key")?.[1]?.type, "LIR");
  assert.equal(itemHistory(state, "deleted key")?.[1]?.type, "SUP");
});

test("old snapshots keep item links without synthesizing history", () => {
  const { key_history: _, ...old } = state;
  assert.equal(itemHistory(old, "21604"), null);
  assert.deepEqual(listRegisterItems(old, "code").map(({ key }) => key), ["21604", "deleted key", "lapsed / key"]);
});

test("opaque route tokens safely distinguish spaces, slashes, unicode and composite keys", () => {
  const keys = ["a b", "a/b", "a%2Fb", "a | b", "../", "", "日本 / 7", "a/b | c"];
  assert.equal(new Set(keys.map(itemRouteToken)).size, keys.length);
  for (const key of keys) {
    const token = itemRouteToken(key);
    assert.match(token, /^k-[A-Za-z0-9_-]*$/);
    assert.equal(Buffer.from(token.slice(2), "base64url").toString("utf8"), key);
    assert.equal(itemPath("mnc", key), `/registers/mnc/items/${token}/`);
  }
});


test("matches producer composite and multilingual key semantics without whitespace normalization", () => {
  const composite = { ...state, active_entries: [
    { name: { en: "English", fr: "Français / 1" }, number: 7 },
    { name: { en: "Fallback", fr: "" } },
    { name: {}, number: null },
    { name: " A B ", number: 0 },
  ], key_history: {}, deleted_keys: [], lapsed_keys: [] };
  const items = listRegisterItems(composite, ["name", "number"]);
  assert.deepEqual(items.map(({ key }) => key), [" A B  | 0", "Fallback | ", "Français / 1 | 7"]);
  assert.equal(items[2]?.entry?.number, 7);
});
