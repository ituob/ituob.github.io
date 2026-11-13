import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakePatchPublisher, setPublisher } from "../worker/lib/publisher.ts";
import { api, db, provisionItu, seedFixtures } from "./helpers.ts";

const ADMIN = "itu-admin@example.test", EDITOR = "itu-editor@example.test";
const endpoint = "/api/admin/general-messages";
const value = { type: "misc_communications", ob_issue_no: "1351", contents: "A newly authored bulletin notice." };
let fake: FakePatchPublisher;
const call = (method: string, suffix = "", body?: unknown, access = ADMIN) => api(method, endpoint + suffix, { access, body });
beforeEach(async () => {
  await seedFixtures(); await provisionItu("itu-admin", ["itu-admin"]); await provisionItu("itu-editor", ["itu-editor"]);
  fake = new FakePatchPublisher(); setPublisher(fake);
});
afterEach(() => setPublisher(null));
async function create() {
  const result = await call("POST", "", { ob_issue_no: 1351, type: value.type, value }, EDITOR);
  expect(result.status).toBe(200);
  return result.json.draft;
}

describe("general message review routes", () => {
  it("requires exact approved revision and administrator before reserving or publishing", async () => {
    const draft = await create(), suffix = `/${draft.id}/review`;
    expect((await call("POST", suffix, { expected_revision: 1 })).status).toBe(409);
    expect((await call("POST", `/${draft.id}/approve`, { expected_revision: 1 })).status).toBe(200);
    expect((await call("POST", suffix, { expected_revision: 1 }, EDITOR)).status).toBe(403);
    expect((await call("POST", suffix, { expected_revision: 2 })).status).toBe(409);
    expect(fake.requests).toEqual([]);
    expect(await db().prepare("SELECT count(*) n FROM general_message_prs").first("n")).toBe(0);
  });
  it("publishes exact approved bytes once and reports real PR state without publishing an edition", async () => {
    const draft = await create(), suffix = `/${draft.id}/review`;
    const approved = await call("POST", `/${draft.id}/approve`, { expected_revision: 1 });
    const first = await call("POST", suffix, { expected_revision: 1 });
    expect(first.status).toBe(202);
    expect((await call("POST", suffix, { expected_revision: 1 })).json.pr).toEqual(first.json.pr);
    expect(fake.createdPrs).toBe(1);
    expect(fake.requests[0]).toMatchObject({ content: approved.json.draft.content_yaml, path: "ob-issues/1351/misc_communications/001.yaml", branch: `rt-msg-1351-${draft.id}-r1` });
    expect((await call("GET", suffix)).json.pending).toBe(true);
    fake.mergePr(first.json.pr.pr_number);
    expect((await call("GET", suffix)).json.pending).toBe(false);
    expect((await call("POST", `/${draft.id}`, { expected_revision: 1, value })).status).toBe(409);
    expect(fake.pinRequests).toEqual([]);
    expect(await db().prepare("SELECT count(*) n FROM editions").first("n")).toBe(0);
  });
  it("retains a reservation on upstream failure and resumes the same reviewed bytes", async () => {
    const draft = await create(), suffix = `/${draft.id}/review`;
    await call("POST", `/${draft.id}/approve`, { expected_revision: 1 }); fake.failNext = 1;
    expect((await call("POST", suffix, { expected_revision: 1 })).status).toBe(502);
    const reserved = (await call("GET", suffix)).json;
    expect(reserved.state).toBeNull(); expect(reserved.pending).toBe(true);
    expect((await call("POST", `/${draft.id}`, { expected_revision: 1, value: { ...value, contents: "Changed" } })).status).toBe(409);
    const retry = await call("POST", suffix, { expected_revision: 1 });
    expect(retry.status).toBe(202);
    expect(retry.json.pr.content_yaml).toBe(reserved.pr.content_yaml);
    expect(fake.createdPrs).toBe(1);
  });
});
