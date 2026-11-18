import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeEmailSender, setEmailSender } from "../worker/lib/email.ts";
import { FakePatchPublisher, setPublisher } from "../worker/lib/publisher.ts";
import { handleQueue } from "../worker/queue-consumer.ts";
import { parseFeedback } from "../worker/lib/email-feedback.ts";
import { activateMember, api, db, provisionItu, seedFixtures } from "./helpers.ts";

const SECRET_B64 = btoa("0123456789abcdef0123456789abcdef");
const SECRET = `whsec_${SECRET_B64}`;
const EDITOR = "itu-editor@example.test";
const ADMINU = "itu-admin@example.test";
const E = () => ({ ...env, EMAIL_WEBHOOK_SECRET: SECRET }) as any;

async function sign(id: string, ts: number, body: string, secretB64 = SECRET_B64) {
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(atob(secretB64), (c) => c.charCodeAt(0)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`)));
  return `v1,${btoa(String.fromCharCode(...mac))}`;
}
const event = (type: string, emailId: string, extra: object = {}) => JSON.stringify({ type, created_at: "2026-11-18T00:00:00Z", data: { email_id: emailId, ...extra } });
async function post(body: string, o: { id?: string; ts?: number; sig?: string | null; secret?: string; e?: any } = {}) {
  const id = o.id ?? "msg_1";
  const ts = o.ts ?? Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = { "Content-Type": "application/json", "svix-id": id, "svix-timestamp": String(ts) };
  const sig = o.sig === undefined ? await sign(id, ts, body, o.secret) : o.sig;
  if (sig !== null) headers["svix-signature"] = sig;
  const { default: worker } = await import("../worker/index.ts");
  return worker.fetch(new Request("http://localhost/api/email/webhook", { method: "POST", headers, body }), o.e ?? E());
}

let sender: FakeEmailSender;
beforeEach(async () => {
  await seedFixtures();
  await activateMember("member-A", "A");
  await provisionItu("itu-editor", ["itu-editor"]);
  await provisionItu("itu-admin", ["itu-admin"]);
  setPublisher(new FakePatchPublisher());
  sender = new FakeEmailSender();
  setEmailSender(sender);
});
afterEach(() => { setPublisher(null); setEmailSender(null); });

const one = async (sql: string, ...b: unknown[]) => db().prepare(sql).bind(...b).first<any>();
const rows = async (sql: string, ...b: unknown[]) => (await db().prepare(sql).bind(...b).all<any>()).results;
const entry = (n = "89 358 01") => ({ country_or_area: { en: "Aland" }, company_name: "Acme Telecom", issue_id_number: n });
async function submitOne(slug: string, iin = "89 358 01") {
  const r = await api("POST", "/api/me/submissions", { session: "member-A", body: { register_id: "E118_IIN", slug, action_type: "ADD", payload: { type: "ADD", data: { _class: "E118Amendment", entries: [entry(iin)] } } } });
  expect(r.status).toBe(201);
  expect((await api("POST", `/api/me/submissions/${r.json.submission.id}/submit`, { session: "member-A", body: {} })).status).toBeLessThan(300);
}
async function drain() {
  const ids = (await rows(`SELECT id FROM notifications WHERE email_status IN ('queued','failed') ORDER BY id`)).map((r) => r.id);
  const batch = createMessageBatch("ituob-notify", [{ id: "m1", timestamp: new Date(), attempts: 1, body: { notification_ids: ids } }]);
  const ctx = createExecutionContext();
  await handleQueue(batch as any, env as any);
  return getQueueResult(batch, ctx);
}
/** One real send to the editor; returns the provider id the consumer stored. */
async function oneSent() {
  await submitOne("e118-iin");
  await drain();
  expect(sender.sent.length).toBeGreaterThan(0);
  const n = await one(`SELECT email_provider_id AS pid FROM notifications WHERE email_status='sent' AND user_id='itu-editor'`);
  expect(n.pid).toBeTruthy();
  return n.pid as string;
}

describe("signature", () => {
  it("fails closed with 503 when the secret is not configured", async () => {
    expect((await post(event("email.bounced", "x"), { e: { ...env } })).status).toBe(503);
  });
  it("rejects unsigned, wrongly signed, wrong-secret, tampered-body and stale requests and changes nothing", async () => {
    const pid = await oneSent();
    const body = event("email.complained", pid);
    expect((await post(body, { sig: null })).status).toBe(401);
    expect((await post(body, { sig: "v1,AAAA" })).status).toBe(401);
    expect((await post(body, { sig: "v2," + (await sign("msg_1", 0, body)).slice(3) })).status).toBe(401);
    expect((await post(body, { secret: btoa("ffffffffffffffffffffffffffffffff") })).status).toBe(401);
    const good = await sign("msg_1", Math.floor(Date.now() / 1000), body);
    expect((await post(body.replace("complained", "bounced"), { sig: good })).status).toBe(401); // body changed after signing
    const stale = Math.floor(Date.now() / 1000) - 3600;
    expect((await post(body, { ts: stale })).status).toBe(401);
    expect((await post(body, { e: { ...env, EMAIL_WEBHOOK_SECRET: "whsec_!!!notbase64" } })).status).toBe(401);
    expect((await one(`SELECT COUNT(*) AS n FROM email_suppressions`)).n).toBe(0);
    expect((await one(`SELECT COUNT(*) AS n FROM notifications WHERE email_status='complained'`)).n).toBe(0);
    expect((await post(body)).status).toBe(200); // control: the same request, properly signed, works
  });
  it("accepts one valid entry among several in a rotated signature list", async () => {
    const pid = await oneSent();
    const body = event("email.delivered", pid);
    const ts = Math.floor(Date.now() / 1000);
    const ok = await sign("msg_1", ts, body);
    expect((await post(body, { sig: `v1,AAAA ${ok}`, ts })).status).toBe(200);
  });
});

describe("bounce, complaint, idempotency, suppression", () => {
  it("maps a permanent bounce to status, counter and suppression exactly once under replay", async () => {
    const pid = await oneSent();
    const body = event("email.bounced", pid, { bounce: { type: "Permanent", subType: "General", message: "mailbox does not exist" } });
    const first = await post(body);
    expect(first.status).toBe(200);
    expect((await first.json() as any).status).toBe("applied");
    const again = await post(body, { id: "msg_other" });
    expect((await again.json() as any).status).toBe("duplicate");
    expect((await post(body)).status).toBe(200);
    const n = await one(`SELECT email_status, email_reason FROM notifications WHERE email_provider_id=?1`, pid);
    expect(n).toMatchObject({ email_status: "bounced", email_reason: "mailbox does not exist" });
    expect((await one(`SELECT SUM(n) AS n FROM notification_counters WHERE metric='bounced'`)).n).toBe(1);
    const s = await rows(`SELECT email, reason, detail FROM email_suppressions`);
    expect(s).toEqual([{ email: EDITOR, reason: "hard_bounce", detail: "mailbox does not exist" }]);
  });

  it("records a complaint (even after a bounce) as a complaint suppression, once", async () => {
    const pid = await oneSent();
    await post(event("email.delivered", pid));
    expect((await one(`SELECT email_status AS s FROM notifications WHERE email_provider_id=?1`, pid)).s).toBe("delivered");
    const body = event("email.complained", pid);
    expect((await post(body)).status).toBe(200);
    expect((await post(body)).status).toBe(200);
    expect((await one(`SELECT email_status AS s FROM notifications WHERE email_provider_id=?1`, pid)).s).toBe("complained");
    expect((await one(`SELECT SUM(n) AS n FROM notification_counters WHERE metric='complained'`)).n).toBe(1);
    expect((await rows(`SELECT reason FROM email_suppressions`)).map((r) => r.reason)).toEqual(["complaint"]);
  });

  it("a soft bounce and unrelated events change nothing", async () => {
    const pid = await oneSent();
    for (const b of [event("email.bounced", pid, { bounce: { type: "Transient" } }), event("email.bounced", pid), event("email.opened", pid), JSON.stringify({ type: "email.complained", data: {} }), "[]"]) {
      const r = await post(b);
      expect(r.status).toBe(200);
      expect((await r.json() as any).status).toBe("ignored");
    }
    expect((await one(`SELECT COUNT(*) AS n FROM email_suppressions`)).n).toBe(0);
    expect((await one(`SELECT email_status AS s FROM notifications WHERE email_provider_id=?1`, pid)).s).toBe("sent");
  });

  it("answers 404 for an unknown provider id (the provider redelivers) and 400 for signed non-JSON", async () => {
    expect((await post(event("email.bounced", "nope", { bounce: { type: "Permanent" } }))).status).toBe(404);
    expect((await one(`SELECT COUNT(*) AS n FROM email_suppressions`)).n).toBe(0);
    expect((await post("not json")).status).toBe(400);
  });

  it("a digest message shared by several notification rows counts each and suppresses the address once", async () => {
    const pid = await oneSent();
    await db().prepare(`INSERT INTO notifications (id,user_id,kind,dedupe_key,payload,created_at,email_status,email_provider_id)
      SELECT 'twin','itu-editor','submission.submitted','twin-key','{}','2026-11-18T00:00:00Z','sent',?1`).bind(pid).run();
    expect((await post(event("email.bounced", pid, { bounce: { type: "Permanent" } }))).status).toBe(200);
    expect((await one(`SELECT SUM(n) AS n FROM notification_counters WHERE metric='bounced'`)).n).toBe(2);
    expect((await one(`SELECT COUNT(*) AS n FROM email_suppressions`)).n).toBe(1);
  });

  it("a later notification to a suppressed address is skipped, not sent", async () => {
    const pid = await oneSent();
    const before = sender.sent.length;
    await post(event("email.bounced", pid, { bounce: { type: "Permanent" } }));
    await db().prepare(`INSERT INTO notifications (id,user_id,kind,dedupe_key,payload,created_at,email_status)
      VALUES ('later','itu-editor','submission.submitted','later-key','{}','2026-11-18T01:00:00Z','queued')`).run();
    await drain();
    expect(sender.sent.length).toBe(before);
    const skipped = await rows(`SELECT email_status, email_reason FROM notifications WHERE id='later'`);
    expect(skipped).toHaveLength(1);
    expect(skipped.every((r) => r.email_reason === "skipped:suppressed")).toBe(true);
    expect((await one(`SELECT n FROM notification_counters WHERE metric='skipped_suppressed'`)).n).toBeGreaterThan(0);
  });

  it("does not overwrite a manual suppression", async () => {
    const pid = await oneSent();
    await db().prepare(`INSERT INTO email_suppressions(email,reason,first_seen) VALUES (?1,'manual','2026-01-01T00:00:00Z')`).bind(EDITOR.toUpperCase()).run();
    await post(event("email.complained", pid));
    expect(await rows(`SELECT reason FROM email_suppressions`)).toEqual([{ reason: "manual" }]);
  });
});

describe("parseFeedback", () => {
  it("only Permanent bounces map to bounced", () => {
    expect(parseFeedback({ type: "email.bounced", data: { email_id: "a", bounce: { type: "Permanent" } } }).kind).toBe("bounced");
    expect(parseFeedback({ type: "email.bounced", data: { email_id: "a", bounce: { type: "Undetermined" } } }).kind).toBe("ignored");
    expect(parseFeedback(null).kind).toBe("ignored");
  });
});

describe("GET /api/admin/notifications/stats", () => {
  it("is Access-gated and admin-only", async () => {
    expect((await api("GET", "/api/admin/notifications/stats")).status).toBe(403);
    expect((await api("GET", "/api/admin/notifications/stats", { access: EDITOR })).status).toBe(403);
    expect((await api("GET", "/api/admin/notifications/stats", { access: ADMINU })).status).toBe(200);
  });
  it("reports exact counters over 14 days, suppression totals and status counts", async () => {
    const pid = await oneSent();
    const today = new Date().toISOString().slice(0, 10);
    const old = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10);
    await db().prepare(`INSERT INTO notification_counters(day,metric,n) VALUES (?1,'bounced',99)`).bind(old).run();
    await post(event("email.bounced", pid, { bounce: { type: "Permanent", message: "gone" } }));
    const stats = (await api("GET", "/api/admin/notifications/stats", { access: ADMINU })).json;
    expect(stats.ok).toBe(true);
    expect(stats.days[today].bounced).toBe(1);
    expect(stats.totals.bounced).toBe(1); // the 20-day-old row is outside the window
    expect(stats.days[old]).toBeUndefined();
    expect(stats.totals.sent).toBeGreaterThan(0);
    expect(stats.suppressions).toEqual({ hard_bounce: 1 });
    expect(stats.recentSuppressions).toHaveLength(1);
    expect(stats.recentSuppressions[0]).toMatchObject({ email: EDITOR, reason: "hard_bounce", detail: "gone" });
    expect(stats.notificationStatus.bounced).toBe(1);
  });
});
