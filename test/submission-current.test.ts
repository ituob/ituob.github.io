import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import { readSubmission } from "../worker/lib/submissions.ts";
import worker from "../worker/index.ts";
import { db, provisionItu, seedFixtures } from "./helpers.ts";

const current = { country_or_area: { en: "Aland" }, company_name: "Acme", issue_id_number: "89 358 01" };
const snapshot = { active_entries: [current], lapsed_keys: [] };
const session = { userId: "itu-editor", roles: ["itu-admin"], memberStateId: null } as any;
let fetchAsset: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  await seedFixtures();
  await provisionItu("itu-editor", ["itu-editor"]);
  fetchAsset = vi.fn(async () => Response.json(snapshot));
});
async function create(action_type: string, entries: unknown[]) {
  const res = await worker.fetch(new Request("http://localhost/api/me/submissions", {
    method: "POST", headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin", "X-Stub-Session": "itu-editor" },
    body: JSON.stringify({ register_id: "E118_IIN", slug: "e118-iin", action_type, payload: { type: action_type, data: { _class: "E118Amendment", entries } } }),
  }), { ...env, ASSETS: { fetch: fetchAsset } } as any);
  const json = await res.json() as any;
  expect(res.status).toBe(201);
  return json.submission.id as string;
}
it("returns the current register item for a REP so the reviewer sees a real before value", async () => {
  const id = await create("REP", [{ ...current, company_name: "Acme 2" }]);
  fetchAsset.mockClear();
  const read = await readSubmission(db(), session, id, { fetch: fetchAsset } as any);
  expect(new URL(fetchAsset.mock.calls[0]![0].url).pathname).toBe("/data/snapshots/e118-iin/current.json");
  expect(read.current).toEqual({ available: true, items: [{ key: expect.any(String), status: "active", entry: current }] });
});
it("marks an item missing from the snapshot as unknown and gives ADD no before", async () => {
  const id = await create("REP", [{ ...current, issue_id_number: "89 358 99" }]);
  const read = await readSubmission(db(), session, id, { fetch: fetchAsset } as any);
  expect(read.current.items[0]).toMatchObject({ status: "unknown", entry: null });
  const add = await create("ADD", [{ ...current, country_or_area: { en: "New" } }]);
  fetchAsset.mockClear();
  expect((await readSubmission(db(), session, add, { fetch: fetchAsset } as any)).current).toEqual({ available: false, items: [] });
  expect(fetchAsset).not.toHaveBeenCalled();
});
it("degrades to unavailable when the snapshot cannot be read", async () => {
  const id = await create("REP", [current]);
  fetchAsset.mockImplementation(async () => new Response("missing", { status: 404 }));
  expect((await readSubmission(db(), session, id, { fetch: fetchAsset } as any)).current.available).toBe(false);
  expect((await readSubmission(db(), session, id)).current.available).toBe(false);
});
