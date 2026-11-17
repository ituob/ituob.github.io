import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import { approve } from "../worker/lib/submissions.ts";
import worker from "../worker/index.ts";
import { db, provisionItu, seedFixtures } from "./helpers.ts";

const entry = { country_or_area: { en: "Aland" }, company_name: "Acme", issue_id_number: "89 358 01" };
const payload = (entries = [entry]) => ({ type: "ADD", data: { _class: "E118Amendment", entries } });
const snapshot = { active_entries: [entry], lapsed_keys: [] };
let fetchAsset: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  await seedFixtures();
  await provisionItu("itu-editor", ["itu-editor"]);
  fetchAsset = vi.fn(async () => Response.json(snapshot));
});
async function call(path = "", body: unknown = { register_id: "E118_IIN", slug: "e118-iin", action_type: "ADD", payload: payload() }) {
  const res = await worker.fetch(new Request(`http://localhost/api/me/submissions${path}`, {
    method: /^\/[0-9A-Z]{26}$/.test(path) ? "PUT" : "POST", headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin", "X-Stub-Session": "itu-editor" },
    body: JSON.stringify(body),
  }), { ...env, ASSETS: { fetch: fetchAsset } } as any);
  return { status: res.status, json: await res.json() as any };
}
it("loads the catalog slug through ASSETS and returns advisory state conflicts to the submitter and revision", async () => {
  const r = await call();
  expect(r.status).toBe(201);
  expect(fetchAsset).toHaveBeenCalledOnce();
  expect(new URL(fetchAsset.mock.calls[0]![0].url).pathname).toBe("/data/snapshots/e118-iin/current.json");
  expect(r.json.warnings.some((w: any) => w.message.includes("already exists"))).toBe(true);
  const row = await db().prepare("SELECT validation FROM submission_revisions WHERE submission_id=?1").bind(r.json.submission.id).first<any>();
  expect(JSON.parse(row.validation).warnings).toEqual(r.json.warnings);
});
it("rechecks state when editing, submitting, revising and approving", async () => {
  const r = await call();
  const id = r.json.submission.id;
  for (const [path, b] of [[`/${id}`, { payload: payload() }], [`/${id}/submit`, {}]] as const) {
    const result = await call(path, b);
    expect(result.status).toBe(200);
    expect(result.json.warnings.some((w: any) => w.message.includes("already exists"))).toBe(true);
  }
  await db().prepare("UPDATE submissions SET state='changes_requested' WHERE id=?1").bind(id).run();
  const revised = await call(`/${id}/revise`, { payload: payload() });
  expect(revised.status).toBe(200);
  expect(revised.json.warnings.some((w: any) => w.message.includes("already exists"))).toBe(true);
  await db().prepare("UPDATE submissions SET state='in_review' WHERE id=?1").bind(id).run();
  await approve(db(), { userId: "itu-editor", roles: ["itu-admin"], memberStateId: null }, id,
    { target_edition: 1351, override_self_review: true }, "ituob/itu-ob-data", undefined, { fetch: fetchAsset });
  expect(fetchAsset).toHaveBeenCalledTimes(5);
});
it.each(["404", "throws", "html", "invalid shape"])("%s snapshot degrades to local checks with a warning, never a 500", async (failure) => {
  fetchAsset.mockImplementation(async () => {
    if (failure === "throws") throw new Error("unavailable");
    if (failure === "html") return new Response("<html>not a snapshot</html>");
    if (failure === "invalid shape") return Response.json({ active_entries: {}, lapsed_keys: [] });
    return new Response("missing", { status: 404 });
  });
  const r = await call();
  expect(r.status).toBe(201);
  expect(r.json.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ path: "register_state", code: "unknown" })]));
  const duplicate = await call("", { register_id: "E118_IIN", slug: "e118-iin", action_type: "ADD", payload: payload([entry, entry]) });
  expect(duplicate.status).toBe(422);
  expect(duplicate.json.errors.some((e: any) => e.message.includes("more than once"))).toBe(true);
  expect(duplicate.json.warnings.length).toBeGreaterThan(0);
});
