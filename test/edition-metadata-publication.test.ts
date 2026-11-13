import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { metadataMergeForPublication } from "../worker/lib/edition-metadata-publication.ts";
import { FakePatchPublisher, setPublisher } from "../worker/lib/publisher.ts";
import { activateMember, api, db, provisionItu, seedFixtures } from "./helpers.ts";

const admin = { userId: "itu-admin", roles: ["itu-admin"] as ["itu-admin"], memberStateId: null };
const ADMIN = "itu-admin@example.test", EDITOR = "itu-editor@example.test";
const endpoint = "/api/admin/composer/editions/1351/metadata";
const metadata = { id: 1351, publication_date: "2026-12-01", cutoff_date: "2026-11-15" };
let fake: FakePatchPublisher;
const call = (method: string, suffix = "", body?: unknown, access = ADMIN) => api(method, endpoint + suffix, { access, body });
beforeEach(async () => {
  await seedFixtures();
  await activateMember("member-A", "A");
  await provisionItu("itu-admin", ["itu-admin"]);
  await provisionItu("itu-editor", ["itu-editor"]);
  fake = new FakePatchPublisher(); setPublisher(fake);
});
afterEach(() => setPublisher(null));
async function schedule() {
  const saved = await call("POST", "", { metadata, expected_revision: 0 });
  expect(saved.status).toBe(200);
  const scheduled = await call("POST", "/schedule", { expected_revision: saved.json.draft.revision });
  expect(scheduled.status).toBe(200);
  return scheduled.json.draft.revision as number;
}

describe("metadata review publication", () => {
  it("requires admin and an exact scheduled revision before any publisher write", async () => {
    const revision = await schedule();
    expect((await call("POST", "/open-pr", { expected_revision: revision }, EDITOR)).status).toBe(403);
    expect((await call("POST", "/open-pr", { expected_revision: revision }, "member-A@example.test")).status).toBe(403);
    expect((await call("POST", "/open-pr", { expected_revision: revision - 1 })).status).toBe(409);
    expect(fake.requests).toEqual([]);
    expect(await db().prepare("SELECT count(*) n FROM edition_metadata_prs").first("n")).toBe(0);
  });
  it("reserves exact bytes, opens one reviewed PR, and locks metadata across retries", async () => {
    expect(await metadataMergeForPublication(db(), admin, 1351, fake)).toBeNull();
    const revision = await schedule();
    await expect(metadataMergeForPublication(db(), admin, 1351, fake)).rejects.toThrow(/review/);
    const first = await call("POST", "/open-pr", { expected_revision: revision });
    expect(first.status).toBe(202);
    const retry = await call("POST", "/open-pr", { expected_revision: revision });
    expect(retry.json.pr).toEqual(first.json.pr);
    expect(fake.createdPrs).toBe(1);
    expect(fake.requests[0].branch).toBe(`rt-meta-1351-r${revision}`);
    expect(fake.requests[0].path).toBe("ob-issues/1351/meta.yaml");
    expect(fake.requests[0].content).toBe(first.json.pr.content_yaml);
    expect((await call("POST", "", { metadata: { ...metadata, cutoff_date: "2026-11-16" }, expected_revision: revision })).status).toBe(409);
    const pending = await call("GET", "/pr");
    expect(pending.json.pending).toBe(true);
    await expect(metadataMergeForPublication(db(), admin, 1351, fake)).rejects.toThrow(/merged/);
    fake.mergePr(first.json.pr.pr_number);
    const merged = await call("GET", "/pr");
    expect(merged.json.pending).toBe(false);
    expect(merged.json.state.mergeSha).toBe("m".repeat(40));
    expect(fake.pinRequests).toEqual([]);
    expect(await metadataMergeForPublication(db(), admin, 1351, fake)).toEqual({ submissionId: `edition-1351-metadata-r${revision}`, mergeSha: "m".repeat(40) });
  });
  it("keeps reservation on upstream failure and resumes without accepting changed metadata", async () => {
    const revision = await schedule(); fake.failNext = 1;
    expect((await call("POST", "/open-pr", { expected_revision: revision })).status).toBe(502);
    const saved = await db().prepare("SELECT * FROM edition_metadata_prs").first<any>();
    expect(saved.pr_number).toBeNull();
    expect((await call("POST", "", { metadata, expected_revision: revision })).status).toBe(409);
    const pending = await call("GET", "/pr");
    expect(pending.json.state).toBeNull();
    const retry = await call("POST", "/open-pr", { expected_revision: revision });
    expect(retry.status).toBe(202);
    expect(retry.json.pr.content_yaml).toBe(saved.content_yaml);
    expect(fake.createdPrs).toBe(1);
  });
});
