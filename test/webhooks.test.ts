import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyChain } from "../worker/lib/audit.ts";
import { handleWebhook } from "../worker/lib/github-webhook.ts";
import { FakePatchPublisher, setPublisher } from "../worker/lib/publisher.ts";
import { activateMember, api, db, provisionItu, seedFixtures } from "./helpers.ts";

const SECRET = "test-webhook-secret";
const EDITOR = "itu-editor@example.test";
const ADMINU = "itu-admin@example.test";
const payload = () => ({ type: "ADD", data: { _class: "E118Amendment", entries: [{ country_or_area: { en: "Aland" }, company_name: "Acme Telecom" }] } });

let fake: FakePatchPublisher;
beforeEach(async () => {
  await seedFixtures();
  await activateMember("member-A", "A");
  await provisionItu("itu-editor", ["itu-editor"]);
  await provisionItu("itu-admin", ["itu-admin"]);
  fake = new FakePatchPublisher();
  setPublisher(fake);
});
afterEach(() => setPublisher(null));

const rows = async (sql: string, ...b: unknown[]) => (await db().prepare(sql).bind(...b).all<any>()).results;
const one = async (sql: string, ...b: unknown[]) => (await db().prepare(sql).bind(...b).first<any>())!;
const stateOf = async (id: string) => (await one("SELECT state FROM submissions WHERE id=?1", id)).state as string;
const me = (id: string, verb: string, b: unknown = {}) => api("POST", `/api/me/submissions/${id}/${verb}`, { session: "member-A", body: b });
const adm = (id: string, verb: string, who = EDITOR, b: unknown = {}) => api("POST", `/api/admin/submissions/${id}/${verb}`, { access: who, body: b });

async function toPrOpen() {
  const c = await api("POST", "/api/me/submissions", { session: "member-A", body: { register_id: "E118_IIN", slug: "e118-iin", action_type: "ADD", payload: payload() } });
  const id = c.json.submission.id as string;
  expect((await me(id, "submit")).status).toBe(200);
  expect((await adm(id, "start-review")).status).toBe(200);
  const a = await adm(id, "approve", EDITOR, { target_edition: 1351 });
  expect(a.status).toBe(200);
  expect(await stateOf(id)).toBe("pr_open");
  const pr = await one("SELECT * FROM submission_prs WHERE submission_id=?1 ORDER BY rev DESC", id);
  return { id, pr };
}

async function sign(body: string, secret = SECRET) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return "sha256=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let seq = 0;
async function hook(event: string, payload: unknown, o: { delivery?: string; signature?: string | null; raw?: string } = {}) {
  const raw = o.raw ?? JSON.stringify(payload);
  const headers: Record<string, string> = { "Content-Type": "application/json", "X-GitHub-Event": event, "X-GitHub-Delivery": o.delivery ?? `d-${++seq}` };
  if (o.signature !== null) headers["X-Hub-Signature-256"] = o.signature ?? (await sign(raw));
  const res = await exports.default.fetch(new Request("http://localhost/api/github/webhook", { method: "POST", headers, body: raw }));
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

const prEvent = (pr: any, o: { merged?: boolean; number?: number; repo?: string; headRepo?: string; base?: string; branch?: string; sha?: string } = {}) => ({
  action: "closed",
  repository: { full_name: o.repo ?? pr.repo },
  pull_request: {
    number: o.number ?? pr.pr_number, merged: o.merged ?? false, merge_commit_sha: o.merged ? "m".repeat(40) : null,
    head: { ref: o.branch ?? pr.branch, sha: pr.commit_sha, repo: { full_name: o.headRepo ?? o.repo ?? pr.repo } }, base: { ref: o.base ?? "main" },
  },
});
const suite = (pr: any, conclusion: string, o: { id?: number; sha?: string; branch?: string } = {}) => ({
  action: "completed", repository: { full_name: pr.repo },
  check_suite: { id: o.id ?? ++seq + 1000, head_branch: o.branch ?? pr.branch, head_sha: o.sha ?? pr.commit_sha, conclusion },
});
const run = (pr: any, name: string, conclusion: string) => ({
  action: "completed", repository: { full_name: pr.repo },
  check_run: { id: ++seq + 5000, name, head_sha: pr.commit_sha, conclusion, check_suite: { head_branch: pr.branch } },
});

describe("signature, secret and replay", () => {
  it("fails closed without a secret; refuses missing/bad signatures before parsing", async () => {
    const req = new Request("http://x/api/github/webhook", { method: "POST", headers: { "X-GitHub-Event": "ping", "X-GitHub-Delivery": "z" }, body: "{}" });
    expect((await handleWebhook(req, { DB: env.DB } as any)).status).toBe(503);

    const body = JSON.stringify({ action: "closed" });
    expect((await hook("pull_request", null, { raw: body, signature: null })).status).toBe(401);
    expect((await hook("pull_request", null, { raw: body, signature: "sha256=" + "0".repeat(64) })).status).toBe(401);
    expect((await hook("pull_request", null, { raw: body, signature: await sign(body, "other-secret") })).status).toBe(401);
    expect((await hook("pull_request", null, { raw: body, signature: (await sign(body)).replace("sha256=", "sha1=") })).status).toBe(401);
    expect((await hook("pull_request", null, { raw: body, signature: "sha256=zz" })).status).toBe(401);
    // a bad signature is a 401 even when the body is not JSON: nothing is parsed first
    expect((await hook("pull_request", null, { raw: "not json", signature: "sha256=" + "1".repeat(64) })).status).toBe(401);
    // signed but not JSON: 400
    expect((await hook("pull_request", null, { raw: "not json" })).status).toBe(400);
    // a signature over a different body does not authenticate this one
    expect((await hook("pull_request", null, { raw: body, signature: await sign(body + " ") })).status).toBe(401);
    expect((await hook("ping", { zen: "x" })).json.status).toBe("pong");
    expect((await rows("SELECT * FROM webhook_deliveries")).length).toBe(0);
  });

  it("a replayed delivery id AND the same body under a fresh delivery id are both no-ops", async () => {
    const { id, pr } = await toPrOpen();
    const ev = prEvent(pr, { merged: true });
    const first = await hook("pull_request", ev, { delivery: "D1" });
    expect(first).toMatchObject({ status: 200, json: { status: "applied", to: "merged" } });
    const before = { rs: (await rows("SELECT id FROM review_state WHERE submission_id=?1", id)).length, n: (await rows("SELECT id FROM notifications")).length, a: (await rows("SELECT id FROM audit_log")).length };
    expect((await hook("pull_request", ev, { delivery: "D1" })).json.status).toBe("duplicate");
    // X-GitHub-Delivery is not covered by the HMAC: the body hash catches the replay under a new id
    expect((await hook("pull_request", ev, { delivery: "D2-replay" })).json.status).toBe("duplicate");
    // a differently-bodied merge event for a PR that is already merged is a state-level no-op
    const other = { ...ev, sender: { login: "x" } };
    expect((await hook("pull_request", other, { delivery: "D3" })).status).toBe(202);
    expect({ rs: (await rows("SELECT id FROM review_state WHERE submission_id=?1", id)).length, n: (await rows("SELECT id FROM notifications")).length, a: (await rows("SELECT id FROM audit_log")).length }).toEqual(before);
    expect((await rows("SELECT * FROM webhook_deliveries")).length).toBe(1);
  });
});

describe("only PRs we created", () => {
  it("unrelated repo, branch, fork, PR number, base and event are ignored with 202 and change nothing", async () => {
    const { id, pr } = await toPrOpen();
    const cases: [string, unknown][] = [
      ["pull_request", prEvent(pr, { merged: true, repo: "someone/else" })],
      ["pull_request", prEvent(pr, { merged: true, branch: "feature/x" })],
      ["pull_request", prEvent(pr, { merged: true, branch: "rt-sub-1-001-nope-ABCDEFGH" })],
      ["pull_request", prEvent(pr, { merged: true, headRepo: "fork/service-publications-docs" })],
      ["pull_request", prEvent(pr, { merged: true, number: 999 })],
      ["pull_request", prEvent(pr, { merged: true, base: "release" })],
      ["pull_request", { ...prEvent(pr, { merged: true }), action: "opened" }],
      ["check_suite", suite(pr, "failure", { branch: "main" })],
      ["check_suite", { ...suite(pr, "failure"), repository: { full_name: "someone/else" } }],
      ["issues", { action: "opened" }],
    ];
    for (const [ev, body] of cases) expect((await hook(ev, body)).status, JSON.stringify(body)).toBe(202);
    expect(await stateOf(id)).toBe("pr_open");
    expect((await rows("SELECT * FROM webhook_deliveries")).length).toBe(0);
  });
});

describe("transitions", () => {
  it("merged: pr_open -> merged by github, merge_sha kept, proposer notified, system comment, audited", async () => {
    const { id, pr } = await toPrOpen();
    const r = await hook("pull_request", prEvent(pr, { merged: true }));
    expect(r.json).toMatchObject({ status: "applied", from: "pr_open", to: "merged" });
    expect(await one("SELECT pr_state, merge_sha FROM submission_prs WHERE submission_id=?1", id)).toEqual({ pr_state: "merged", merge_sha: "m".repeat(40) });
    expect(await one("SELECT actor_kind, actor_id, from_state, to_state FROM review_state WHERE submission_id=?1 ORDER BY id DESC", id)).toEqual({ actor_kind: "github", actor_id: null, from_state: "pr_open", to_state: "merged" });
    expect((await rows("SELECT user_id FROM notifications WHERE kind='submission.pr_merged' AND submission_id=?1", id)).map((n) => n.user_id)).toContain("member-A");
    const sys = await rows("SELECT c.kind, c.author_id, r.body FROM comments c JOIN comment_revisions r ON r.comment_id=c.id WHERE c.submission_id=?1 AND c.kind='system' ORDER BY c.created_at, c.id", id);
    expect(sys.map((c) => c.body)).toEqual(["State changed from pr_pending to pr_open.", `Pull request #${pr.pr_number} was merged (${"m".repeat(7)}).`]);
    expect(sys.every((c) => c.author_id === null)).toBe(true);
    expect(await one("SELECT count(*) n FROM audit_log WHERE action='github.pull_request.merged' AND submission_id=?1", id)).toEqual({ n: 1 });
    expect(await verifyChain(db())).toBeNull();
    // a human cannot reach merged through any API
    expect((await adm(id, "approve")).status).toBe(409);
  });

  it("closed without merge: -> changes_requested with a reason; the proposer can revise and a NEW PR opens", async () => {
    const { id, pr } = await toPrOpen();
    const r = await hook("pull_request", prEvent(pr, { merged: false }));
    expect(r.json).toMatchObject({ status: "applied", to: "changes_requested" });
    expect(await one("SELECT pr_state FROM submission_prs WHERE submission_id=?1", id)).toEqual({ pr_state: "closed" });
    expect((await one("SELECT reason FROM review_state WHERE submission_id=?1 ORDER BY id DESC", id)).reason).toMatch(/closed without merging/);
    expect((await rows("SELECT kind FROM notifications WHERE user_id='member-A' AND submission_id=?1", id)).map((n) => n.kind)).toContain("submission.changes_requested");
    expect((await rows("SELECT body FROM comment_revisions WHERE body LIKE '%closed without merging%'")).length).toBe(1);
    // the dead end that in_review would have been: same rev cannot get a second submission_prs row, a revision can
    expect((await me(id, "revise", { payload: { ...payload(), data: { _class: "E118Amendment", entries: [{ country_or_area: { en: "Aland" }, company_name: "Acme Telecom 2" }] } } })).status).toBe(200);
    expect((await adm(id, "start-review")).status).toBe(200);
    const a = await adm(id, "approve", EDITOR, { target_edition: 1351 });
    expect(a.status).toBe(200);
    expect(fake.createdPrs).toBe(2);
    expect(await stateOf(id)).toBe("pr_open");
    // a late event for the OLD PR does not move the submission
    expect((await hook("pull_request", { ...prEvent(pr, { merged: true }), note: "late" })).status).toBe(202);
    expect(await stateOf(id)).toBe("pr_open");
  });

  it("our own close (admin withdrawal) is not mistaken for a human closing the PR", async () => {
    const { id, pr } = await toPrOpen();
    await db().prepare("UPDATE submission_prs SET closing_at='t' WHERE submission_id=?1").bind(id).run();
    expect((await hook("pull_request", prEvent(pr))).status).toBe(202);
    expect(await stateOf(id)).toBe("pr_open");
    await db().prepare("UPDATE submission_prs SET closing_at=NULL WHERE submission_id=?1").bind(id).run();
    expect((await adm(id, "withdraw", ADMINU, { reason: "no" })).status).toBe(200);
    expect(fake.closed.length).toBe(1);
    expect((await hook("pull_request", { ...prEvent(pr), note: "after" })).status).toBe(202);
    expect(await stateOf(id)).toBe("withdrawn");
    expect(await one("SELECT closing_at IS NOT NULL AS c FROM submission_prs WHERE submission_id=?1", id)).toEqual({ c: 1 });
  });

  it("merged after withdrawal is recorded as an anomaly, not a transition", async () => {
    const { id, pr } = await toPrOpen();
    expect((await adm(id, "withdraw", ADMINU, { reason: "no" })).status).toBe(200);
    const r = await hook("pull_request", prEvent(pr, { merged: true }));
    expect(r.json).toMatchObject({ status: "applied", anomaly: "merged_while_withdrawn" });
    expect(await stateOf(id)).toBe("withdrawn");
    expect(await one("SELECT count(*) n FROM audit_log WHERE action='github.merged_while_withdrawn'")).toEqual({ n: 1 });
    expect(await verifyChain(db())).toBeNull();
  });

  it("ci_failed, stale head ignored, recovery, and merge from ci_failed", async () => {
    const { id, pr } = await toPrOpen();
    expect((await hook("check_suite", suite(pr, "failure", { sha: "f".repeat(40) }))).status).toBe(202); // stale head
    // a green result while open changes no state; it is only recorded
    expect((await hook("check_suite", suite(pr, "success"))).json).toMatchObject({ status: "applied", from: "pr_open", to: "pr_open" });
    expect(await stateOf(id)).toBe("pr_open");

    const f = await hook("check_run", run(pr, "Instance-data validation", "failure"));
    expect(f.json).toMatchObject({ status: "applied", from: "pr_open", to: "ci_failed" });
    expect(JSON.parse((await one("SELECT checks FROM submission_prs WHERE submission_id=?1", id)).checks)).toMatchObject({ "run:Instance-data validation": "failure" });
    // editors and admins hear about it (design matrix), with the failing check named
    const n = await rows("SELECT user_id, payload FROM notifications WHERE kind='submission.ci_failed' AND submission_id=?1", id);
    expect(n.map((x) => x.user_id).sort()).toEqual(["itu-admin", "itu-editor"]);
    expect(JSON.parse(n[0].payload).reason).toMatch(/Instance-data validation/);
    // a green suite does not recover while a recorded run is still failing
    expect((await hook("check_suite", suite(pr, "success"))).json).toMatchObject({ status: "applied", from: "ci_failed", to: "ci_failed" });
    expect(await stateOf(id)).toBe("ci_failed");
    const ok = await hook("check_run", run(pr, "Instance-data validation", "success"));
    expect(ok.json).toMatchObject({ status: "applied", from: "ci_failed", to: "pr_open" });
    expect(await one("SELECT actor_kind FROM review_state WHERE submission_id=?1 ORDER BY id DESC", id)).toEqual({ actor_kind: "github" });

    // fail again, then a human merges anyway: merged wins
    expect((await hook("check_suite", suite(pr, "failure"))).json.to).toBe("ci_failed");
    expect((await hook("pull_request", prEvent(pr, { merged: true }))).json).toMatchObject({ from: "ci_failed", to: "merged" });
    // events after merge change nothing
    expect((await hook("check_suite", suite(pr, "failure"))).status).toBe(202);
    expect(await stateOf(id)).toBe("merged");
    expect(await verifyChain(db())).toBeNull();
    // every automated transition left a system comment; the thread API shows them to the proposer
    const thread = await api("GET", `/api/me/submissions/${id}/comments`, { session: "member-A", headers: { "Sec-Fetch-Site": "same-origin" } });
    expect(thread.status).toBe(200);
    expect(thread.json.comments.filter((c: any) => c.kind === "system").length).toBeGreaterThanOrEqual(5);
  });

  it("closed-unmerged from ci_failed also goes back to the proposer", async () => {
    const { id, pr } = await toPrOpen();
    await hook("check_suite", suite(pr, "failure"));
    expect(await stateOf(id)).toBe("ci_failed");
    expect((await hook("pull_request", prEvent(pr))).json.to).toBe("changes_requested");
  });
});

describe("withdraw / openPr race", () => {
  async function approvedWithRace(closeFails = false) {
    const c = await api("POST", "/api/me/submissions", { session: "member-A", body: { register_id: "E118_IIN", slug: "e118-iin", action_type: "ADD", payload: payload() } });
    const id = c.json.submission.id as string;
    await me(id, "submit");
    await adm(id, "start-review");
    // the admin withdraws at the moment GitHub finished creating the PR, before the consumer records it
    fake.afterCreate = async () => {
      fake.afterCreate = null;
      expect((await adm(id, "withdraw", ADMINU, { reason: "mistake" })).status).toBe(200);
      fake.failClose = closeFails;
    };
    const a = await adm(id, "approve", EDITOR, { target_edition: 1351 });
    return { id, a };
  }

  it("the PR that was created for a withdrawn submission is closed and audited", async () => {
    const { id, a } = await approvedWithRace();
    expect(a.json.pr).toMatchObject({ state: "withdrawn", pr_number: 1, error: null });
    expect(await stateOf(id)).toBe("withdrawn");
    expect(fake.closed).toEqual([expect.objectContaining({ prNumber: 1 })]);
    expect(await one("SELECT pr_number, pr_state FROM submission_prs WHERE submission_id=?1", id)).toEqual({ pr_number: 1, pr_state: "closed" });
    expect(await one("SELECT count(*) n FROM audit_log WHERE action='pr.closed_after_withdraw' AND submission_id=?1", id)).toEqual({ n: 1 });
    expect(await verifyChain(db())).toBeNull();
    // and the webhook for that PR, were it merged, is only an anomaly record
    // retrying the consumer after the fact makes no second PR and no transition
    expect((await adm(id, "open-pr")).status).toBe(409);
    expect(fake.createdPrs).toBe(1);
  });

  it("if the close itself fails, the open PR is recorded for a human instead of being forgotten", async () => {
    const { id, a } = await approvedWithRace(true);
    expect(a.json.pr).toMatchObject({ state: "withdrawn", pr_number: 1 });
    expect(a.json.pr.error).toMatch(/502/);
    expect(await one("SELECT pr_number, pr_state, last_error FROM submission_prs WHERE submission_id=?1", id)).toMatchObject({ pr_number: 1, pr_state: "open" });
    expect(await one("SELECT count(*) n FROM audit_log WHERE action='pr.orphan_close_failed'")).toEqual({ n: 1 });
  });
});
