import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyChain } from "../worker/lib/audit.ts";
import { FakeEmailSender, setEmailSender } from "../worker/lib/email.ts";
import { FakePatchPublisher, setPublisher } from "../worker/lib/publisher.ts";
import { flushOutbox, sweep } from "../worker/lib/outbox.ts";
import { emailAllowed, parseMentionsForTest } from "./mention-shim.ts";
import { MAX_ATTEMPTS, handleQueue } from "../worker/queue-consumer.ts";
import { activateMember, api, db, provisionItu, seedFixtures } from "./helpers.ts";

const sources = import.meta.glob("../worker/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const EDITOR = "itu-editor@example.test";
const ADMINU = "itu-admin@example.test";
const entry = () => ({ country_or_area: "Aland", company_name: "Acme Telecom" });
const payload = () => ({ type: "ADD", data: { _class: "E118Amendment", entries: [entry()] } });
const subBody = () => ({ register_id: "E118_IIN", slug: "e118-iin", action_type: "ADD", payload: payload() });

let sender: FakeEmailSender;
beforeEach(async () => {
  await seedFixtures();
  await activateMember("member-A", "A");
  await activateMember("member-B", "B");
  await provisionItu("itu-editor", ["itu-editor"]);
  await provisionItu("itu-admin", ["itu-admin"]);
  setPublisher(new FakePatchPublisher());
  sender = new FakeEmailSender();
  setEmailSender(sender);
  for (const [u, h] of [["member-A", "alice-a"], ["member-B", "bob-b"], ["itu-editor", "edith-e"], ["itu-admin", "adam-ad"], ["unaffiliated", "una-un"]]) {
    expect((await api("PUT", "/api/me/handle", { session: u!, body: { handle: h } })).status).toBe(200);
  }
});
afterEach(() => { setPublisher(null); setEmailSender(null); });

const SAME = { "Sec-Fetch-Site": "same-origin" };
const one = async (sql: string, ...b: unknown[]) => (await db().prepare(sql).bind(...b).first<any>());
const notes = async (user: string, kind?: string) =>
  (await db().prepare(`SELECT * FROM notifications WHERE user_id=?1 ${kind ? "AND kind=?2" : ""} ORDER BY created_at, id`).bind(...(kind ? [user, kind] : [user])).all<any>()).results;
const me = (id: string, verb: string, user = "member-A", b: unknown = {}) => api("POST", `/api/me/submissions/${id}/${verb}`, { session: user, body: b });
const adm = (id: string, verb: string, who = EDITOR, b: unknown = {}) => api("POST", `/api/admin/submissions/${id}/${verb}`, { access: who, body: b });
async function draft() {
  const r = await api("POST", "/api/me/submissions", { session: "member-A", body: subBody() });
  expect(r.status).toBe(201);
  return r.json.submission.id as string;
}
const say = (id: string, user: string, text: string, extra: Record<string, unknown> = {}) =>
  api("POST", `/api/me/submissions/${id}/comments`, { session: user, body: { body: text, ...extra } });

/** Run the queue consumer over everything the request path enqueued (local stand-in for Queues delivery). */
async function drain() {
  const ids = (await db().prepare(`SELECT id FROM notifications WHERE email_status IN ('queued','failed') ORDER BY id`).all<{ id: string }>()).results.map((r) => r.id);
  const batch = createMessageBatch("ituob-notify", [{ id: "m1", timestamp: new Date(), attempts: 1, body: { notification_ids: ids } }]);
  const ctx = createExecutionContext();
  await handleQueue(batch as any, env as any);
  return getQueueResult(batch, ctx);
}

describe("pure rules", () => {
  it("email gating by level", () => {
    expect(emailAllowed("submission.approved", "all")).toBe(true);
    expect(emailAllowed("submission.approved", "mentions")).toBe(false);
    expect(emailAllowed("comment.mention", "mentions")).toBe(true);
    expect(emailAllowed("submission.rejected", "mentions")).toBe(true); // D3
    expect(emailAllowed("submission.rejected", "none")).toBe(false);
    expect(parseMentionsForTest("hi @Alice-A, mail a@bob-b.org and @@x and @alice-a.")).toEqual(["alice-a"]);
  });
});

describe("queue plumbing (premise check)", () => {
  it("the local workers pool provides a working Queue producer binding", async () => {
    expect(typeof env.NOTIFY_Q!.send).toBe("function");
    await env.NOTIFY_Q!.send({ notification_ids: ["x"] });
  });
  it("a committed write enqueues via the producer and marks the rows; nothing is emailed", async () => {
    const id = await draft();
    await me(id, "submit");
    const n = await notes("itu-editor", "submission.submitted");
    expect(n).toHaveLength(1);
    expect(n[0].enqueued_at).not.toBeNull();
    expect(n[0].email_status).toBe("queued");
    expect(sender.sent).toHaveLength(0);
  });
  it("without a queue the rows stay queued and unenqueued (not lost); flush later hands them over", async () => {
    const id = await draft();
    const saved = (env as any).NOTIFY_Q;
    (env as any).NOTIFY_Q = { send: async () => { throw new Error("queue down"); } };
    try { await me(id, "submit"); } finally { (env as any).NOTIFY_Q = saved; }
    const n = await notes("itu-editor", "submission.submitted");
    expect(n[0].enqueued_at).toBeNull();
    expect(await flushOutbox(env as any)).toBe(1);
    expect((await notes("itu-editor", "submission.submitted"))[0].enqueued_at).not.toBeNull();
  });
});

describe("request path never sends email", () => {
  it("no request-path module imports the email sender; only the queue consumer does", () => {
    const importers = Object.entries(sources).filter(([f, t]) => /from "(\.\/|\.\/lib\/|\.\.\/lib\/)?email\.ts"/.test(t) && !f.endsWith("/lib/email.ts")).map(([f]) => f);
    expect(importers).toEqual(["../worker/queue-consumer.ts"]);
    expect(sources["../worker/index.ts"]).toMatch(/queue-consumer/); // index only wires queue()
  });
  it("a full workflow + discussion through the HTTP surface reaches the sender zero times", async () => {
    const id = await draft();
    await me(id, "submit");
    await adm(id, "start-review");
    await say(id, "member-A", "hello @edith-e");
    await adm(id, "request-changes", EDITOR, { reason: "fix it" });
    expect(sender.sent).toHaveLength(0);
    expect((await one(`SELECT count(*) n FROM notifications WHERE email_status='queued'`)).n).toBeGreaterThan(0);
    await drain();
    expect(sender.sent.length).toBeGreaterThan(0);
  });
});

describe("event emission", () => {
  it("the proposer is notified on every transition they did not cause; reviewers on submit and on resubmission", async () => {
    const id = await draft();
    expect((await me(id, "submit")).status).toBe(200);
    expect(await notes("itu-editor", "submission.submitted")).toHaveLength(1);
    await adm(id, "start-review");
    await adm(id, "request-changes", EDITOR, { reason: "needs a fix" });
    expect((await me(id, "revise", "member-A", { payload: { ...payload(), data: { _class: "E118Amendment", entries: [{ ...entry(), company_name: "Acme Telecom Ltd" }] } } })).status).toBe(200);
    expect(await notes("itu-editor", "submission.submitted")).toHaveLength(2); // new revision
    await adm(id, "start-review");
    expect((await adm(id, "approve", EDITOR, { target_edition: 1351 })).status).toBe(200);
    const kinds = (await notes("member-A")).map((n) => n.kind);
    expect(kinds).toEqual(["submission.in_review", "submission.changes_requested", "submission.in_review", "submission.approved", "submission.pr_opened"]);
    // the actor never notifies themselves; withdrawal by an admin reaches the proposer
    expect(await notes("itu-editor", "submission.in_review")).toHaveLength(0);
    expect((await adm(id, "withdraw", ADMINU, { reason: "superseded" })).status).toBe(200);
    expect((await notes("member-A")).map((n) => n.kind).at(-1)).toBe("submission.withdrawn");
  });

  it("a rejected transition writes no notification (events are not invented on rollback)", async () => {
    const id = await draft();
    const r = await adm(id, "start-review"); // illegal from draft
    expect(r.status).toBe(409);
    expect((await one(`SELECT count(*) n FROM notifications`)).n).toBe(0);
  });

  it("notification rows are created idempotently by dedupe_key", async () => {
    const id = await draft();
    await me(id, "submit");
    const n = (await notes("itu-editor"))[0];
    await db().prepare(`INSERT INTO notifications (id,user_id,submission_id,kind,dedupe_key,payload,created_at) VALUES ('X','itu-editor',?1,'k',?2,'{}','t') ON CONFLICT (dedupe_key) DO NOTHING`).bind(id, n.dedupe_key).run();
    expect(await notes("itu-editor")).toHaveLength(1);
  });
});

describe("comments, mentions, prefs", () => {
  it("a mention notifies the mentioned account; none silences email but keeps the inbox row", async () => {
    const id = await draft();
    await me(id, "submit");
    expect((await api("PUT", "/api/me/notification-prefs", { session: "itu-editor", body: { level: "none" } })).status).toBe(200);
    expect((await api("PUT", "/api/me/notification-prefs", { session: "itu-admin", body: { level: "mentions" } })).status).toBe(200);
    const c = await say(id, "member-A", "please look @edith-e and @adam-ad");
    expect(c.status).toBe(201);
    const ed = (await notes("itu-editor", "comment.mention"))[0];
    expect(ed.email_status).toBe("skipped");
    expect(ed.email_reason).toBe("skipped:prefs");
    const ad = (await notes("itu-admin", "comment.mention"))[0];
    expect(ad.email_status).toBe("queued");
    await drain();
    expect(sender.sent.map((m) => m.to)).toContain("itu-admin@example.test");
    expect(sender.sent.map((m) => m.to)).not.toContain("itu-editor@example.test");
    // mentioned ITU user is now a participant; no duplicate comment.created for the mentioned
    expect(await notes("itu-editor", "comment.created")).toHaveLength(0);
  });

  it("mention rules: mentioning a user without read access is refused and nothing is stored; unknown handles are plain text", async () => {
    const id = await draft();
    const r = await say(id, "member-A", "hi @bob-b");
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/bob-b/);
    expect((await one(`SELECT count(*) n FROM comments`)).n).toBe(0);
    expect((await say(id, "member-A", "hi @nobody-here")).status).toBe(201);
  });

  it("comment.created goes to proposer + reviewers, not the author; reply notifies the parent author", async () => {
    const id = await draft();
    await me(id, "submit");
    const root = (await say(id, "itu-editor", "root question")).json.comment;
    expect(await notes("member-A", "comment.created")).toHaveLength(1);
    expect(await notes("itu-editor", "comment.created")).toHaveLength(0);
    await say(id, "member-A", "my answer", { parent_id: root.id });
    expect(await notes("itu-editor", "comment.reply")).toHaveLength(1);
  });

  it("edit adds a revision and notifies only NEW mentions; history is immutable", async () => {
    const id = await draft();
    await me(id, "submit");
    const c = (await say(id, "member-A", "v1 @edith-e")).json.comment;
    const e = await api("PUT", `/api/me/submissions/${id}/comments/${c.id}`, { session: "member-A", body: { body: "v2 @edith-e @adam-ad" } });
    expect(e.status).toBe(200);
    expect(e.json.comment.current_rev).toBe(2);
    expect(await notes("itu-editor", "comment.mention")).toHaveLength(1);
    expect(await notes("itu-admin", "comment.mention")).toHaveLength(1);
    expect((await one(`SELECT count(*) n FROM comment_revisions WHERE comment_id=?1`, c.id)).n).toBe(2);
    expect((await api("PUT", `/api/me/submissions/${id}/comments/${c.id}`, { session: "itu-editor", body: { body: "rewrite" } })).status).toBe(403);
    for (const s of Object.values(sources)) expect(s).not.toMatch(/(UPDATE|DELETE FROM)\s+comment_revisions/i);
  });

  it("tombstone keeps history: hidden in the thread, kept in history, audited; moderator needs a reason", async () => {
    const id = await draft();
    await me(id, "submit");
    const c = (await say(id, "member-A", "oops secret text")).json.comment;
    const noReason = await api("DELETE", `/api/admin/submissions/${id}/comments/${c.id}`, { access: EDITOR, body: {} });
    expect(noReason.status).toBe(400);
    const del = await api("DELETE", `/api/admin/submissions/${id}/comments/${c.id}`, { access: EDITOR, body: { reason: "off topic" } });
    expect(del.status).toBe(200);
    const thread = await api("GET", `/api/me/submissions/${id}/comments`, { session: "member-A", headers: SAME });
    expect(thread.json.comments[0].deleted_at).not.toBeNull();
    expect(thread.json.comments[0].revisions).toEqual([]);
    const hist = await api("GET", `/api/me/submissions/${id}/history`, { session: "member-A", headers: SAME });
    expect(hist.json.revisions.map((r: any) => r.body)).toEqual(["oops secret text"]);
    expect(hist.json.comments[0].delete_reason).toBe("off topic");
    const adminHist = await api("GET", `/api/admin/submissions/${id}/history`, { access: ADMINU });
    expect(adminHist.json.audit.map((a: any) => a.action)).toEqual(expect.arrayContaining(["comment.created", "comment.deleted"]));
    expect((await api("POST", `/api/admin/submissions/${id}/comments/${c.id}/restore`, { access: ADMINU, body: { reason: "mistake" } })).status).toBe(200);
    expect(await verifyChain(db())).toBeNull();
  });

  it("anchors are validated and stored per revision", async () => {
    const id = await draft();
    const ok = await say(id, "member-A", "this field", { anchor: { path: "data.entries[0].company_name", quote: "Acme Telecom" } });
    expect(ok.json.comment.anchor_rev).toBe(1);
    expect((await say(id, "member-A", "x", { anchor: { rev: 9, path: "a" } })).status).toBe(400);
  });
});

describe("access", () => {
  it("involved parties read the full discussion and their notification history; others are denied", async () => {
    const id = await draft();
    await me(id, "submit");
    await say(id, "member-A", "hello");
    await adm(id, "start-review");
    expect((await api("GET", `/api/me/submissions/${id}/comments`, { session: "member-B", headers: SAME })).status).toBe(404);
    expect((await api("GET", `/api/me/submissions/${id}/history`, { session: "unaffiliated", headers: SAME })).status).toBe(404);
    expect((await say(id, "member-B", "intrude")).status).toBe(404);
    const own = await api("GET", `/api/me/submissions/${id}/history`, { session: "member-A", headers: SAME });
    expect(own.status).toBe(200);
    expect(own.json.comments).toHaveLength(1);
    expect(own.json.transitions.map((t: any) => t.to_state)).toEqual(["draft", "submitted", "in_review"]);
    expect(own.json.notifications.map((n: any) => n.kind)).toEqual(["submission.in_review"]);
    const ed = await api("GET", `/api/admin/submissions/${id}/history`, { access: EDITOR });
    expect(ed.json.notifications.map((n: any) => n.kind)).toContain("submission.submitted");
    // a contact added by an editor becomes involved
    expect((await api("POST", `/api/admin/submissions/${id}/participants`, { access: EDITOR, body: { userId: "member-B", role: "contact" } })).status).toBe(201);
    expect((await api("GET", `/api/me/submissions/${id}/history`, { session: "member-B", headers: SAME })).status).toBe(200);
    expect((await one(`SELECT level FROM notification_prefs WHERE user_id='member-B'`)).level).toBe("mentions");
    expect((await api("POST", `/api/admin/submissions/${id}/participants`, { access: EDITOR, body: { userId: "ghost", role: "contact" } })).status).toBe(400);
  });

  it("close/reopen needs a reason, blocks members but not ITU, is audited and notifies", async () => {
    const id = await draft();
    await me(id, "submit");
    expect((await api("POST", `/api/admin/submissions/${id}/discussion/close`, { access: EDITOR, body: {} })).status).toBe(400);
    expect((await api("POST", `/api/admin/submissions/${id}/discussion/close`, { access: EDITOR, body: { reason: "settled" } })).status).toBe(200);
    expect((await say(id, "member-A", "late")).status).toBe(409);
    expect((await api("POST", `/api/admin/submissions/${id}/comments`, { access: EDITOR, body: { body: "ITU may still comment" } })).status).toBe(201);
    expect(await notes("member-A", "discussion.closed")).toHaveLength(1);
    expect((await api("POST", `/api/admin/submissions/${id}/discussion/reopen`, { access: ADMINU, body: { reason: "more to say" } })).status).toBe(200);
    expect((await say(id, "member-A", "back")).status).toBe(201);
    expect((await one(`SELECT count(*) n FROM audit_log WHERE action IN ('discussion.closed','discussion.reopened')`)).n).toBe(2);
    expect((await api("POST", `/api/me/submissions/${id}/discussion/close`, { session: "member-A", body: { reason: "x" } })).status).toBe(403);
  });

  it("inbox read + prefs are per user and audited", async () => {
    const id = await draft();
    await me(id, "submit");
    const list = await api("GET", "/api/me/notifications", { session: "itu-editor", headers: SAME });
    expect(list.json.notifications).toHaveLength(1);
    const nid = list.json.notifications[0].id;
    expect((await api("POST", `/api/me/notifications/${nid}/read`, { session: "member-A" })).status).toBe(404);
    expect((await api("POST", `/api/me/notifications/${nid}/read`, { session: "itu-editor" })).status).toBe(200);
    expect((await api("GET", "/api/me/notifications?unread=1", { session: "itu-editor", headers: SAME })).json.notifications).toHaveLength(0);
    expect((await api("PUT", "/api/me/notification-prefs", { session: "member-A", body: { level: "loud" } })).status).toBe(400);
    await api("PUT", "/api/me/notification-prefs", { session: "member-A", body: { level: "none" } });
    expect((await one(`SELECT count(*) n FROM audit_log WHERE action='prefs.changed'`)).n).toBe(1);
  });
});

describe("delivery: consumer, retry, counters", () => {
  it("sender failure is retried, counted and never lost; success is idempotent", async () => {
    const id = await draft();
    await me(id, "submit");
    sender.failNext = 1;
    const r1 = await drain();
    expect(r1.retryMessages.length).toBe(1);
    let n = (await notes("itu-editor"))[0];
    expect(n.email_status).toBe("failed");
    expect(n.email_attempts).toBe(1);
    expect(n.email_reason).toMatch(/503/);
    const r2 = await drain();
    expect(r2.explicitAcks.length).toBe(1);
    n = (await notes("itu-editor"))[0];
    expect(n.email_status).toBe("sent");
    expect(n.email_provider_id).toBe("fake-1");
    expect(sender.sent).toHaveLength(1);
    await drain(); // redelivery of an already-sent row sends nothing more
    expect(sender.sent).toHaveLength(1);
    const c = Object.fromEntries((await db().prepare(`SELECT metric,n FROM notification_counters`).all<any>()).results.map((r) => [r.metric, r.n]));
    expect(c.sent).toBe(1);
    expect(c.failed).toBe(1);
  });

  it("the unconfigured real sender fails visibly; after the cap the row is dead and counted, not deleted", async () => {
    setEmailSender(null);
    const id = await draft();
    await me(id, "submit");
    for (let i = 0; i < MAX_ATTEMPTS; i++) await drain();
    const n = (await notes("itu-editor"))[0];
    expect(n.email_status).toBe("failed");
    expect(n.email_attempts).toBe(MAX_ATTEMPTS);
    expect(n.email_reason).toMatch(/^dead: email provider not configured/);
    expect((await one(`SELECT n FROM notification_counters WHERE metric='dlq'`)).n).toBe(1);
    expect(await notes("itu-editor")).toHaveLength(1); // inbox row intact
  });

  it("sweeper re-enqueues stale queued rows and retryable failures, not dead ones", async () => {
    const id = await draft();
    await me(id, "submit");
    await db().prepare(`UPDATE notifications SET enqueued_at='2020-01-01T00:00:00.000Z'`).run();
    expect(await sweep(env as any)).toBe(1);
    expect((await notes("itu-editor"))[0].enqueued_at).not.toBe("2020-01-01T00:00:00.000Z");
    await db().prepare(`UPDATE notifications SET email_status='failed', email_attempts=?1`).bind(MAX_ATTEMPTS).run();
    expect(await sweep(env as any)).toBe(0);
  });

  it("consumer re-checks prefs and suppressions at send time", async () => {
    const id = await draft();
    await me(id, "submit");
    await api("PUT", "/api/me/notification-prefs", { session: "itu-editor", body: { level: "none" } });
    await drain();
    expect(sender.sent).toHaveLength(0);
    expect((await notes("itu-editor"))[0].email_reason).toBe("skipped:prefs");
  });
});
