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


describe("breaker concurrency and retry controls", () => {
  it("overlapping cron and concurrent replay preserve one complete digest", async () => {
    await db().prepare(`INSERT INTO notification_prefs(user_id,level,delivery,updated_at) VALUES ('itu-editor','all','digest','t')`).run();
    await comment("First overlapping item");
    await comment("Second overlapping item");
    await db().prepare(`UPDATE notifications SET created_at='2026-11-17T23:59:00.000Z'`).run();
    const time = Date.parse("2026-11-18T00:00:00Z");
    await Promise.all([worker.scheduled({scheduledTime: time} as ScheduledController,local), worker.scheduled({scheduledTime: time + 3600000} as ScheduledController,local)]);
    await Promise.all(queued.map(body => consume(body)));
    const recorded = await rows("recorded_emails");
    expect(recorded).toHaveLength(1);
    expect(recorded[0].text_body).toContain("First overlapping item");
    expect(recorded[0].text_body).toContain("Second overlapping item");
    expect(await metrics()).toMatchObject({sent:2});
  });
  it("sequential failures stop after five attempts and replay stays stopped", async () => {
    await comment();
    let sends=0;
    setEmailSender({send: async () => { sends++; throw new Error("offline"); }});
    for (let i=1; i<=8; i++) await consume(queued[0]!,i);
    expect(sends).toBe(5);
    expect((await rows("notifications"))[0]).toMatchObject({email_attempts:5,email_status:"failed"});
    expect(await metrics()).toMatchObject({failed:5,dlq:1});
  });
  it("concurrent failures must consume the five-attempt budget", async () => {
    await comment();
    let arrived=0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => {release=resolve});
    setEmailSender({send: async () => { arrived++; if(arrived===6) release(); await barrier; throw new Error("offline concurrent"); }});
    await Promise.all(Array.from({length:6},(_,i)=>consume(queued[0]!,i+1)));
    const n=(await rows("notifications"))[0];
    console.log("BREAKER concurrent failures",JSON.stringify({sends:arrived,attempts:n.email_attempts,metrics:await metrics()}));
    expect(n.email_attempts).toBe(5);
    expect(await metrics()).toMatchObject({ failed: 5, dlq: 1 });
    await consume(queued[0]!, 7);
    expect(arrived).toBe(6);
  });
  it("a stale failure after success must not count a failed or dead notification", async () => {
    await comment();
    await db().prepare(`UPDATE notifications SET email_attempts=4`).run();
    const recording=getEmailSender(local);
    let arrived=0;
    let fail!:()=>void;
    let both!:()=>void;
    const barrier=new Promise<void>(resolve=>{both=resolve});
    const failure=new Promise<void>(resolve=>{fail=resolve});
    setEmailSender({send:async msg=>{const index=++arrived; if(arrived===2)both(); await barrier; if(index===1) return recording.send(msg); await failure; throw new Error("late failure");}});
    const first=consume(queued[0]!);
    const second=consume(queued[0]!);
    await barrier;
    await first;
    fail();
    await second;
    const n=(await rows("notifications"))[0];
    console.log("BREAKER stale failure",JSON.stringify({status:n.email_status,attempts:n.email_attempts,metrics:await metrics()}));
    expect(n.email_status).toBe("sent");
    expect(n.email_attempts).toBe(5);
    expect(await rows("recorded_emails")).toHaveLength(1);
    expect((await metrics()).dlq ?? 0).toBe(0);
    expect((await metrics()).failed ?? 0).toBe(0);
  });

  it("switching to digest while an immediate delivery is in flight must not record twice", async () => {
    vi.useFakeTimers({toFake:["Date"]});
    vi.setSystemTime(new Date("2026-11-17T23:59:59.000Z"));
    await comment("One event, two keys");
    const recording=getEmailSender(local);
    let entered!:()=>void;
    let release!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve});
    const wait=new Promise<void>(resolve=>{release=resolve});
    let calls=0;
    setEmailSender({send:async msg=>{if(++calls===1){entered();await wait;}return recording.send(msg);}});
    const immediate=consume(queued[0]!);
    await started;
    const preferenceResponse=await worker.fetch(new Request("http://localhost/api/me/notification-prefs", {method:"PUT",headers:{"X-Stub-Session":"itu-editor","Sec-Fetch-Site":"same-origin","Content-Type":"application/json"},body:JSON.stringify({level:"all",delivery:"digest"})}),local);
    expect(preferenceResponse.status).toBe(200);
    vi.setSystemTime(new Date("2026-11-18T00:00:00.000Z"));
    await worker.scheduled({scheduledTime:Date.parse("2026-11-18T00:00:00Z")} as ScheduledController,local);
    // Cron must not regroup a claimed immediate delivery. Replay the newest
    // queued message (the original if cron correctly leaves it alone).
    await consume(queued[queued.length - 1]!);
    release();
    await immediate;
    const recorded=await rows("recorded_emails");
    console.log("BREAKER changed key",JSON.stringify(recorded.map(r=>({id:r.id,text:r.text_body}))));
    expect(recorded).toHaveLength(1);
    expect(recorded[0].text_body).toContain("One event, two keys");
    const n = (await rows("notifications"))[0];
    expect(n.digest_key).toBeNull();
    expect(n.email_delivery_key).toBe(n.id);
    expect(await metrics()).toMatchObject({ sent: 1 });
  });

  it("missing DB retries queue work and restored DB records it", async()=>{
    await comment("Survives missing DB");
    const batch=createMessageBatch("ituob-notify",[{id:"no-db",timestamp:new Date(),attempts:1,body:queued[0]!}]);
    await worker.queue(batch,{...local,DB:undefined});
    const result=await getQueueResult(batch,createExecutionContext());
    expect(result.retryBatch.retry).toBe(true);
    expect((await rows("notifications"))[0].email_status).toBe("queued");
    expect(await rows("recorded_emails")).toHaveLength(0);
    await consume(queued[0]!);
    expect(await rows("recorded_emails")).toHaveLength(1);
  });
});
