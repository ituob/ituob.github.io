import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../worker/index.ts";
import { getEmailSender, setEmailSender } from "../worker/lib/email.ts";
import type { Env } from "../worker/lib/types.ts";
import type { NotifyMessage } from "../worker/lib/outbox.ts";
import { activateMember, api, db, provisionItu, seedFixtures } from "./helpers.ts";

let local: Env;
let queued: NotifyMessage[];
let submission: string;
const rows = async (table: string) => (await db().prepare(`SELECT * FROM ${table} ORDER BY id`).all<any>()).results;
async function request(method: string, path: string, body?: unknown) {
  return worker.fetch(new Request(`http://localhost${path}`, {
    method, headers: { "X-Stub-Session": "member-A", "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), local);
}
async function comment(text = "Hello <team>") {
  expect((await request("POST", `/api/me/submissions/${submission}/comments`, { body: text })).status).toBe(201);
}
async function consume(body: NotifyMessage, attempts = 1) {
  const batch = createMessageBatch("ituob-notify", [{ id: "msg", timestamp: new Date(), attempts, body }]);
  await worker.queue(batch, local);
  return getQueueResult(batch, createExecutionContext());
}
const metrics = async () => Object.fromEntries((await db().prepare(`SELECT metric,n FROM notification_counters`).all<any>()).results.map(r => [r.metric, r.n]));
beforeEach(async () => {
  setEmailSender(null);
  await seedFixtures();
  await activateMember("member-A", "A");
  await provisionItu("itu-editor", ["itu-editor"]);
  queued = [];
  local = { ...env, EMAIL_PROVIDER: "recording", NOTIFY_Q: { send: async (body: NotifyMessage) => { queued.push(body); } } } as unknown as Env;
  const draft = await api("POST", "/api/me/submissions", { session: "member-A", body: {
    register_id: "E118_IIN", slug: "e118-iin", action_type: "ADD",
    payload: { type: "ADD", data: { _class: "E118Amendment", entries: [{ country_or_area: { en: "Aland" }, company_name: "Acme" }] } },
  } });
  expect(draft.status).toBe(201);
  submission = draft.json.submission.id;
});
afterEach(() => { setEmailSender(null); vi.useRealTimers(); });

describe("recorded delivery through request, durable outbox and queue", () => {
  it("records the rendered email only in the consumer and deduplicates a repeated message", async () => {
    await db().prepare(`UPDATE users SET locale='fr' WHERE id='itu-editor'`).run();
    await comment();
    const pending = await rows("notifications");
    expect(pending).toHaveLength(1);
    expect(pending[0].email_status).toBe("queued");
    expect(pending[0].enqueued_at).not.toBeNull();
    expect(queued).toEqual([{ notification_ids: [pending[0].id] }]);
    expect(await rows("recorded_emails")).toEqual([]);
    expect((await consume(queued[0]!)).explicitAcks).toHaveLength(1);
    const recorded = await rows("recorded_emails");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ to_address: "itu-editor@example.test", locale: "fr" });
    expect(recorded[0].subject).toContain("ITU OB");
    expect(recorded[0].text_body).toContain("Hello <team>");
    expect(recorded[0].html_body).toContain("Hello &lt;team&gt;");
    expect(recorded[0].html_body).toContain("/api/me/notification-prefs");
    await consume(queued[0]!);
    expect(await rows("recorded_emails")).toEqual(recorded);
    expect((await rows("notifications"))[0]).toMatchObject({ email_status: "sent", email_attempts: 1 });
    expect(await metrics()).toMatchObject({ sent: 1 });
  });

  it("retries a recording failure and recovers without losing or duplicating mail", async () => {
    await comment();
    const recording = getEmailSender(local);
    let fail = true;
    setEmailSender({ send: async msg => { if (fail) { fail = false; throw new Error("recording unavailable"); } return recording.send(msg); } });
    expect((await consume(queued[0]!)).retryMessages).toHaveLength(1);
    expect(await rows("recorded_emails")).toHaveLength(0);
    expect((await rows("notifications"))[0]).toMatchObject({ email_status: "failed", email_attempts: 1 });
    await consume(queued[0]!, 2);
    await consume(queued[0]!, 3);
    expect(await rows("recorded_emails")).toHaveLength(1);
    expect(await metrics()).toMatchObject({ failed: 1, sent: 1 });
  });

  it("holds digest notifications until the scheduled UTC boundary and records one grouped email", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-17T23:59:00Z"));
    await db().prepare(`INSERT INTO notification_prefs(user_id,level,delivery,updated_at) VALUES ('itu-editor','all','digest','t')`).run();
    await comment("First digest comment");
    await comment("Second digest comment");
    expect(queued).toHaveLength(0);
    // Even a prematurely delivered message must respect the preference.
    await consume({ notification_ids: (await rows("notifications")).map(n => n.id) });
    expect(await rows("recorded_emails")).toHaveLength(0);
    await worker.scheduled({ scheduledTime: Date.now() } as ScheduledController, local);
    expect(queued).toHaveLength(0);
    vi.setSystemTime(new Date("2026-11-18T00:00:00Z"));
    await worker.scheduled({ scheduledTime: Date.now() } as ScheduledController, local);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.notification_ids).toHaveLength(2);
    await consume(queued[0]!);
    await consume(queued[0]!);
    const recorded = await rows("recorded_emails");
    expect(recorded).toHaveLength(1);
    expect(recorded[0].text_body).toContain("First digest comment");
    expect(recorded[0].text_body).toContain("Second digest comment");
    expect((await rows("notifications")).every(n => n.email_status === "sent")).toBe(true);
    expect(await metrics()).toMatchObject({ sent: 2 });
    await worker.scheduled({ scheduledTime: Date.now() } as ScheduledController, local);
    expect(queued).toHaveLength(1);
  });

  it("preserves digest rows without a queue and flushes after the binding returns", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-17T23:59:00Z"));
    await db().prepare(`INSERT INTO notification_prefs(user_id,level,delivery,updated_at) VALUES ('itu-editor','all','digest','t')`).run();
    local.NOTIFY_Q = undefined;
    await comment();
    vi.setSystemTime(new Date("2026-11-18T00:00:00Z"));
    await worker.scheduled({ scheduledTime: Date.now() } as ScheduledController, local);
    expect(await rows("recorded_emails")).toHaveLength(0);
    expect((await rows("notifications"))[0]).toMatchObject({ email_status: "queued", enqueued_at: null });
    local.NOTIFY_Q = { send: async (body: NotifyMessage) => { queued.push(body); } } as Env["NOTIFY_Q"];
    await worker.scheduled({ scheduledTime: Date.now() } as ScheduledController, local);
    await consume(queued[0]!);
    expect(await rows("recorded_emails")).toHaveLength(1);
  });
  it("deduplicates concurrent deliveries and counts the notification once", async () => {
    await comment();
    await Promise.all([consume(queued[0]!), consume(queued[0]!)]);
    expect(await rows("recorded_emails")).toHaveLength(1);
    expect(await metrics()).toMatchObject({ sent: 1 });
  });

  it("retries a digest as a group and rechecks consent before recording", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-17T23:59:00Z"));
    await db().prepare(`INSERT INTO notification_prefs(user_id,level,delivery,updated_at) VALUES ('itu-editor','all','digest','t')`).run();
    await comment("Grouped one");
    await comment("Grouped two");
    vi.setSystemTime(new Date("2026-11-18T00:00:00Z"));
    await worker.scheduled({ scheduledTime: Date.now() } as ScheduledController, local);
    const recording = getEmailSender(local);
    setEmailSender({ send: async () => { throw new Error("temporary storage failure"); } });
    expect((await consume(queued[0]!)).retryMessages).toHaveLength(1);
    expect((await rows("notifications")).every(n => n.email_status === "failed")).toBe(true);
    expect(await metrics()).toMatchObject({ failed: 2 });
    setEmailSender(recording);
    await db().prepare(`UPDATE notification_prefs SET level='none' WHERE user_id='itu-editor'`).run();
    expect((await consume(queued[0]!, 2)).explicitAcks).toHaveLength(1);
    expect(await rows("recorded_emails")).toHaveLength(0);
    expect((await rows("notifications")).every(n => n.email_reason === "skipped:prefs")).toBe(true);
    expect(await metrics()).toMatchObject({ skipped_prefs: 2 });
  });

  it("gives late commits a fresh digest key so an already recorded digest cannot swallow them", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-17T23:59:00Z"));
    await db().prepare(`INSERT INTO notification_prefs(user_id,level,delivery,updated_at) VALUES ('itu-editor','all','digest','t')`).run();
    await comment("Before cron");
    vi.setSystemTime(new Date("2026-11-18T00:00:00Z"));
    await worker.scheduled({ scheduledTime: Date.now() } as ScheduledController, local);
    await consume(queued[0]!);
    // A request that started before midnight can commit after the cron snapshot.
    await comment("Committed after cron");
    await db().prepare(`UPDATE notifications SET created_at='2026-11-17T23:59:59.999Z' WHERE digest_key IS NULL`).run();
    await worker.scheduled({ scheduledTime: Date.now() } as ScheduledController, local);
    await consume(queued[1]!);
    const recorded = await rows("recorded_emails");
    expect(recorded).toHaveLength(2);
    expect(recorded.some(n => n.text_body.includes("Committed after cron"))).toBe(true);
    expect(await metrics()).toMatchObject({ sent: 2 });
  });

});
