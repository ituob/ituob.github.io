import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyChain } from "../worker/lib/audit.ts";
import { FakePatchPublisher, setPublisher } from "../worker/lib/publisher.ts";
import { reconcile } from "../worker/lib/reconciler.ts";
import { activateMember, api, db, provisionItu, seedFixtures } from "./helpers.ts";

const SECRET = "test-webhook-secret";
const EDITOR = "itu-editor@example.test";
const ADMINU = "itu-admin@example.test";
const MEMBER_A = "member-A@example.test";
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
const n = async (sql: string, ...b: unknown[]) => (await one(sql, ...b)).n as number;
const stateOf = async (id: string) => (await one("SELECT state FROM submissions WHERE id=?1", id)).state as string;
const me = (id: string, verb: string, b: unknown = {}) => api("POST", `/api/me/submissions/${id}/${verb}`, { session: "member-A", body: b });
const adm = (id: string, verb: string, who = EDITOR, b: unknown = {}) => api("POST", `/api/admin/submissions/${id}/${verb}`, { access: who, body: b });
const comp = (method: string, path: string, who: string | undefined = ADMINU, b?: unknown) => api(method, `/api/admin/composer${path}`, { access: who, body: b });
const counts = async () => [await n("SELECT count(*) n FROM review_state"), await n("SELECT count(*) n FROM audit_log"), await n("SELECT count(*) n FROM edition_items"), await n("SELECT count(*) n FROM submission_reverts")];

async function sign(body: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return "sha256=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
let seq = 0;
async function hook(event: string, p: unknown) {
  const raw = JSON.stringify(p);
  const res = await exports.default.fetch(
    new Request("http://localhost/api/github/webhook", {
      method: "POST", body: raw,
      headers: { "Content-Type": "application/json", "X-GitHub-Event": event, "X-GitHub-Delivery": `c-${++seq}`, "X-Hub-Signature-256": await sign(raw) },
    }),
  );
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}
const closedEvent = (repo: string, branch: string, number: number, merged: boolean, base = "main") => ({
  action: "closed", repository: { full_name: repo },
  pull_request: { number, merged, merge_commit_sha: merged ? "m".repeat(40) : null, head: { ref: branch, repo: { full_name: repo } }, base: { ref: base } },
});

/** draft -> ... -> pr_open (approval opens the PR through the fake). */
async function toPrOpen(slug = "e118-iin", edition = 1351) {
  const targets: Record<string, { register_id: string; className: string; fields: object }> = {
    "e118-iin": { register_id: "E118_IIN", className: "E118Amendment", fields: { company_name: "Acme Telecom" } },
    "e212-mnc": { register_id: "E212_MNC", className: "E212MNCAmendment", fields: { mcc_mnc_codes: "999 99", networks: "Acme Telecom" } },
    "e218-trcc": { register_id: "E218_TRCC", className: "E218TRCCAmendment", fields: { tmcc_code: "999" } },
    "f32-tdi": { register_id: "F32_TDI", className: "F32TDIAmendment", fields: { network_code: "AA" } },
  };
  const target = targets[slug];
  expect(target, `catalog fixture for ${slug}`).toBeDefined();
  const data = { _class: target.className, entries: [{ country_or_area: { en: "Aland" }, ...target.fields }] };
  const c = await api("POST", "/api/me/submissions", { session: "member-A", body: { register_id: target.register_id, slug, action_type: "ADD", payload: { type: "ADD", data } } });
  expect(c.status, JSON.stringify(c.json)).toBe(201);
  const id = c.json.submission.id as string;
  expect((await me(id, "submit")).status).toBe(200);
  expect((await adm(id, "start-review")).status).toBe(200);
  expect((await adm(id, "approve", EDITOR, { target_edition: edition })).status).toBe(200);
  expect(await stateOf(id)).toBe("pr_open");
  return { id, pr: await one("SELECT * FROM submission_prs WHERE submission_id=?1 ORDER BY rev DESC", id) };
}
/** ... -> merged through the real webhook. */
async function toMerged(slug = "e118-iin", edition = 1351) {
  const r = await toPrOpen(slug, edition);
  const h = await hook("pull_request", closedEvent(r.pr.repo, r.pr.branch, r.pr.pr_number, true));
  expect(h.status).toBe(200);
  expect(await stateOf(r.id)).toBe("merged");
  return r;
}
async function placed(slug = "e118-iin", edition = 1351) {
  const r = await toMerged(slug, edition);
  await comp("POST", "/editions", ADMINU, { ob_issue_no: edition });
  expect((await comp("POST", `/editions/${edition}/items`, ADMINU, { submission_id: r.id })).status).toBe(200);
  return r;
}

describe("admin-only guard (Access JWT verification is not built: fail closed)", () => {
  it("every composer route refuses no identity, a session cookie, a member, an editor, and an unknown email", async () => {
    const r = await toMerged();
    const calls: [string, string, unknown?][] = [
      ["GET", "/submissions"], ["GET", "/editions"], ["POST", "/editions", { ob_issue_no: 1351 }], ["GET", "/editions/1351"],
      ["POST", "/editions/1351/items", { submission_id: r.id }], ["POST", `/editions/1351/items/${r.id}/remove`], ["POST", "/editions/1351/publish"],
    ];
    const before = await counts();
    for (const [m, p, b] of calls) {
      expect((await api(m, `/api/admin/composer${p}`, { body: b })).status, `${m} ${p} no identity`).toBe(403);
      expect((await api(m, `/api/admin/composer${p}`, { session: "itu-admin", body: b })).status, `${m} ${p} session only`).toBe(403);
      expect((await api(m, `/api/admin/composer${p}`, { session: "member-A", body: b })).status, `${m} ${p} member session`).toBe(403);
      expect((await comp(m, p, MEMBER_A, b)).status, `${m} ${p} member via Access`).toBe(403);
      expect((await comp(m, p, EDITOR, b)).status, `${m} ${p} editor`).toBe(403);
      expect((await comp(m, p, "nobody@example.test", b)).status, `${m} ${p} unknown email`).toBe(403);
    }
    expect((await api("POST", "/api/admin/reconcile", { access: EDITOR })).status).toBe(403);
    expect((await api("POST", "/api/admin/reconcile", { session: "member-A" })).status).toBe(403);
    expect(await counts()).toEqual(before);
    expect(await stateOf(r.id)).toBe("merged");
  });

  it("there is no member-session route to the composer", async () => {
    for (const p of ["/api/me/composer/submissions", "/api/me/editions", "/api/me/submissions/x/schedule", "/api/me/submissions/x/publish"])
      expect([404, 403]).toContain((await api("POST", p, { session: "member-A", body: {} })).status);
  });
});

describe("composer: merged -> scheduled -> published", () => {
  it("lists merged-unpublished, places, removes, places again and publishes through the pin bump", async () => {
    const r = await toMerged();
    const list = await comp("GET", "/submissions");
    expect(list.json.submissions.map((s: any) => [s.id, s.state, s.target_edition, s.edition])).toEqual([[r.id, "merged", 1351, null]]);
    expect(list.json.submissions[0].merge_sha).toBe("m".repeat(40));

    const created = await comp("POST", "/editions", ADMINU, { ob_issue_no: 1351 });
    expect([created.status, created.json.created, created.json.edition.status]).toEqual([201, true, "open"]);
    const again = await comp("POST", "/editions", ADMINU, { ob_issue_no: 1351 });
    expect([again.status, again.json.created]).toEqual([200, false]);
    expect((await comp("POST", "/editions", ADMINU, { ob_issue_no: 1352 })).status).toBe(409); // one open edition
    expect((await comp("POST", "/editions", ADMINU, { ob_issue_no: "x" })).status).toBe(400);

    const placeRes = await comp("POST", "/editions/1351/items", ADMINU, { submission_id: r.id });
    expect(placeRes.json.submission.state).toBe("scheduled");
    expect((await comp("GET", "/editions/1351")).json.edition.status).toBe("composing");
    expect((await comp("GET", "/submissions")).json.submissions[0].edition).toBe(1351);

    const mergedNotes = () => n("SELECT count(*) n FROM notifications WHERE submission_id=?1 AND kind='submission.pr_merged'", r.id);
    const notesBefore = await mergedNotes();
    expect(notesBefore).toBeGreaterThan(0);
    const removed = await comp("POST", `/editions/1351/items/${r.id}/remove`);
    expect(removed.json.submission.state).toBe("merged");
    expect(await n("SELECT count(*) n FROM edition_items")).toBe(0);
    expect(await mergedNotes()).toBe(notesBefore); // un-placing is not announced again
    expect((await comp("GET", "/editions/1351")).json.edition.status).toBe("open"); // an empty edition frees the slot
    expect((await comp("POST", "/editions/1351/items", ADMINU, { submission_id: r.id })).status).toBe(200);

    expect(fake.pinRequests).toHaveLength(0);
    const pub = await comp("POST", "/editions/1351/publish");
    expect(pub.status).toBe(200);
    expect(pub.json.published).toEqual([r.id]);
    expect(await stateOf(r.id)).toBe("published");
    expect(fake.pinRequests).toHaveLength(1);
    expect(fake.pinRequests[0]!.items).toEqual([{ submissionId: r.id, mergeSha: "m".repeat(40) }]);
    const ed = await one("SELECT * FROM editions WHERE ob_issue_no=1351");
    expect([ed.status, ed.freeze_sha, ed.staging_commit, typeof ed.published_at]).toEqual(["published", fake.pinRequests.length && "f1".padEnd(40, "0"), "s1".padEnd(40, "0"), "string"]);

    // Every move is attributable: review_state + audit, hash chain intact.
    const hist = await rows("SELECT from_state,to_state,actor_kind,actor_id FROM review_state WHERE submission_id=?1 AND to_state IN ('merged','scheduled','published') ORDER BY id", r.id);
    expect(hist.map((h) => `${h.from_state}>${h.to_state}:${h.actor_kind}`)).toEqual(["pr_open>merged:github", "merged>scheduled:user", "scheduled>merged:user", "merged>scheduled:user", "scheduled>published:user"]);
    const aud = await rows("SELECT action,actor_kind,subject_type FROM audit_log WHERE action LIKE 'composer.%' OR action LIKE 'edition.%' ORDER BY id");
    expect(aud.map((a) => a.action)).toEqual(["edition.created", "composer.placed", "composer.removed", "composer.placed", "edition.staged", "composer.published", "edition.published"]);
    expect(await verifyChain(db())).toBeNull();
    // A published submission appears in no work list any more.
    expect((await comp("GET", "/submissions")).json.submissions).toEqual([]);
  });

  it("an edition emptied while another is open is dropped, so the open one can be composed", async () => {
    const a = await toMerged("e118-iin", 1351);
    const b = await toMerged("e212-mnc", 1352);
    await comp("POST", "/editions", ADMINU, { ob_issue_no: 1351 });
    expect((await comp("POST", "/editions/1351/items", ADMINU, { submission_id: a.id })).status).toBe(200);
    expect((await comp("POST", "/editions", ADMINU, { ob_issue_no: 1352 })).status).toBe(201);
    expect((await comp("POST", "/editions/1352/items", ADMINU, { submission_id: b.id })).status).toBe(409); // 1351 holds the slot
    expect((await comp("POST", `/editions/1351/items/${a.id}/remove`)).status).toBe(200);
    expect(await n("SELECT count(*) n FROM editions WHERE ob_issue_no=1351")).toBe(0);
    expect((await comp("POST", "/editions/1352/items", ADMINU, { submission_id: b.id })).status).toBe(200);
    expect(await verifyChain(db())).toBeNull();
  });

  it("orders items by position and one edition composes at a time", async () => {
    const a = await toMerged("e118-iin");
    const b = await toMerged("e212-mnc");
    await comp("POST", "/editions", ADMINU, { ob_issue_no: 1351 });
    await comp("POST", "/editions/1351/items", ADMINU, { submission_id: b.id });
    await comp("POST", "/editions/1351/items", ADMINU, { submission_id: a.id });
    expect((await comp("GET", "/editions/1351")).json.items.map((i: any) => [i.submission_id, i.position])).toEqual([[b.id, 1], [a.id, 2]]);
    // another edition cannot start composing
    const c = await toMerged("e218-trcc", 1352);
    await comp("POST", "/editions", ADMINU, { ob_issue_no: 1352 });
    expect((await comp("POST", "/editions/1352/items", ADMINU, { submission_id: c.id })).status).toBe(409);
    expect(await stateOf(c.id)).toBe("merged");
  });

  it("pending pin PRs and staging failures preserve placements until a confirmed deployment publishes once", async () => {
    const a = await placed("e118-iin");
    const b = await toMerged("e212-mnc");
    await comp("POST", "/editions/1351/items", ADMINU, { submission_id: b.id });
    // Capture actual D1 state, including attribution, notifications and audit before any pin request.
    const snapshot = async () => ({
      edition: await one("SELECT * FROM editions WHERE ob_issue_no=1351"),
      items: await rows("SELECT * FROM edition_items ORDER BY position"),
      submissions: await rows("SELECT * FROM submissions ORDER BY id"),
      history: await rows("SELECT * FROM review_state ORDER BY id"),
      audit: await rows("SELECT * FROM audit_log ORDER BY id"),
      notifications: await rows("SELECT * FROM notifications ORDER BY id"),
    });
    const before = await snapshot();
    const pending = { prNumber: 42, url: "https://github.invalid/site/pull/42", reason: "pin PR is open" };
    const bump = vi.spyOn(fake, "bumpDataPin");
    for (const reason of ["pin PR is open", "staging deployment is pending", "staging deployment failed", "pin PR was closed without merge"]) {
      pending.reason = reason;
      bump.mockResolvedValueOnce({ freezeSha: "unconfirmed-data", siteCommit: "unconfirmed-site", pending });
      const res = await comp("POST", "/editions/1351/publish");
      expect(res.status, reason).toBe(202);
      expect(res.json.pending).toEqual(pending);
      expect(res.json.published).toEqual([]);
      expect([res.json.edition.status, res.json.edition.freeze_sha, res.json.edition.staging_commit, res.json.edition.published_at])
        .toEqual(["composing", null, null, null]);
      expect(await snapshot()).toEqual(before);
    }
    bump.mockRejectedValueOnce(new Error("GitHub read failed"));
    expect((await comp("POST", "/editions/1351/publish")).status).toBe(502);
    expect(await snapshot()).toEqual(before);
    expect(bump.mock.calls).toHaveLength(5);
    for (const [request] of bump.mock.calls) {
      expect(request).toEqual({ edition: 1351, idempotencyKey: "edition-1351-pin", items: [
        { submissionId: a.id, mergeSha: "m".repeat(40) },
        { submissionId: b.id, mergeSha: "m".repeat(40) },
      ] });
    }
    // Ready responses retain the existing ready-provider contract.
    bump.mockRestore();
    const ready = await comp("POST", "/editions/1351/publish");
    expect([ready.status, ready.json.published, ready.json.pending]).toEqual([200, [a.id, b.id], undefined]);
    expect([ready.json.edition.status, ready.json.edition.freeze_sha, ready.json.edition.staging_commit])
      .toEqual(["published", "f1".padEnd(40, "0"), "s1".padEnd(40, "0")]);
    expect(typeof ready.json.edition.published_at).toBe("string");
    expect(await rows("SELECT * FROM edition_items ORDER BY position")).toEqual(before.items);
    for (const id of [a.id, b.id]) {
      expect(await stateOf(id)).toBe("published");
      expect(await rows("SELECT actor_kind, actor_id FROM review_state WHERE submission_id=?1 AND to_state='published'", id))
        .toEqual([{ actor_kind: "user", actor_id: "itu-admin" }]);
      expect(await n("SELECT count(*) n FROM notifications WHERE submission_id=?1 AND kind='submission.published'", id)).toBeGreaterThan(0);
    }
    expect(await n("SELECT count(*) n FROM audit_log WHERE action='edition.staged'")).toBe(1);
    expect(await n("SELECT count(*) n FROM audit_log WHERE action='edition.published'")).toBe(1);
    expect(await n("SELECT count(*) n FROM audit_log WHERE action='composer.published'")).toBe(2);
    const after = await snapshot();
    expect((await comp("POST", "/editions/1351/publish")).status).toBe(409);
    expect(await snapshot()).toEqual(after);
    expect(fake.pinRequests).toHaveLength(1);
    expect(await verifyChain(db())).toBeNull();
  });

  it.each(["add", "replace"])("rejects a ready pin when a concurrent %s changes placement", async (change) => {
    const a = await placed("e118-iin");
    const b = await toMerged("e212-mnc");
    const bump = vi.spyOn(fake, "bumpDataPin").mockImplementationOnce(async () => {
      if (change === "replace") expect((await comp("POST", `/editions/1351/items/${a.id}/remove`)).status).toBe(200);
      expect((await comp("POST", "/editions/1351/items", ADMINU, { submission_id: b.id })).status).toBe(200);
      return { freezeSha: "stale-freeze", siteCommit: "stale-site" };
    });
    const res = await comp("POST", "/editions/1351/publish");
    expect(res.status).toBe(409);
    bump.mockRestore();
    expect(await one("SELECT status, freeze_sha, staging_commit, published_at FROM editions"))
      .toEqual({ status: "composing", freeze_sha: null, staging_commit: null, published_at: null });
    expect(await rows("SELECT submission_id, position FROM edition_items ORDER BY position"))
      .toEqual(change === "add" ? [{ submission_id: a.id, position: 1 }, { submission_id: b.id, position: 2 }] : [{ submission_id: b.id, position: 1 }]);
    expect([await stateOf(a.id), await stateOf(b.id)]).toEqual([change === "add" ? "scheduled" : "merged", "scheduled"]);
    expect(await n("SELECT count(*) n FROM audit_log WHERE action IN ('edition.staged','composer.published','edition.published')")).toBe(0);
    expect(await n("SELECT count(*) n FROM notifications WHERE kind='submission.published'")).toBe(0);
    expect(await verifyChain(db())).toBeNull();
  });

  it("a failed pin bump publishes nothing and a retry publishes once", async () => {
    const r = await placed();
    fake.failNextPin = 1;
    expect((await comp("POST", "/editions/1351/publish")).status).toBe(502);
    expect(await stateOf(r.id)).toBe("scheduled");
    expect((await one("SELECT status FROM editions")).status).toBe("composing");
    expect((await comp("POST", "/editions/1351/publish")).status).toBe(200);
    expect(await stateOf(r.id)).toBe("published");
    expect(await n("SELECT count(*) n FROM audit_log WHERE action='composer.published'")).toBe(1);
  });

  it("a publish interrupted after the bump resumes: staged edition, one item already published", async () => {
    const a = await placed("e118-iin");
    const b = await toMerged("e212-mnc");
    await comp("POST", "/editions/1351/items", ADMINU, { submission_id: b.id });
    expect((await comp("POST", "/editions/1351/publish")).status).toBe(200);
    // Rewind to the interrupted shape by hand: edition staged, one item still scheduled.
    await db().prepare("UPDATE editions SET status='staged', published_at=NULL").run();
    await db().prepare("UPDATE submissions SET state='scheduled' WHERE id=?1").bind(b.id).run();
    const pins = fake.pinRequests.length;
    const res = await comp("POST", "/editions/1351/publish");
    expect([res.status, res.json.published]).toEqual([200, [b.id]]);
    expect(fake.pinRequests).toHaveLength(pins); // no second bump: already staged
    expect(await stateOf(a.id)).toBe("published");
    expect(await stateOf(b.id)).toBe("published");
  });
});

describe("forbidden composer transitions: 409 and nothing written", () => {
  it("only a merged submission can be placed; only a scheduled one removed; only into its own, unfrozen edition", async () => {
    const c = await api("POST", "/api/me/submissions", { session: "member-A", body: { register_id: "E118_IIN", slug: "e118-iin", action_type: "ADD", payload: payload() } });
    const draft = c.json.submission.id as string;
    const sub = (await api("POST", "/api/me/submissions", { session: "member-A", body: { register_id: "E118_IIN", slug: "e118-iin", action_type: "ADD", payload: payload() } })).json.submission.id as string;
    await me(sub, "submit");
    const rev = (await api("POST", "/api/me/submissions", { session: "member-A", body: { register_id: "E118_IIN", slug: "e118-iin", action_type: "ADD", payload: payload() } })).json.submission.id as string;
    await me(rev, "submit");
    await adm(rev, "start-review");
    const open = await toPrOpen("e118-iin");
    const wd = await toPrOpen("e212-mnc");
    await adm(wd.id, "withdraw", ADMINU, { reason: "x" });
    const merged = await toMerged("e218-trcc");
    await comp("POST", "/editions", ADMINU, { ob_issue_no: 1351 });
    const sched = await toMerged("f32-tdi");
    expect((await comp("POST", "/editions/1351/items", ADMINU, { submission_id: sched.id })).status).toBe(200);

    const before = await counts();
    for (const [name, id] of [["draft", draft], ["submitted", sub], ["in_review", rev], ["pr_open", open.id], ["withdrawn", wd.id], ["scheduled", sched.id]] as const)
      expect((await comp("POST", "/editions/1351/items", ADMINU, { submission_id: id })).status, `place from ${name}`).toBe(409);
    for (const [name, id] of [["draft", draft], ["pr_open", open.id], ["merged", merged.id], ["withdrawn", wd.id]] as const)
      expect((await comp("POST", `/editions/1351/items/${id}/remove`)).status, `remove from ${name}`).toBe(409);
    expect((await comp("POST", "/editions/1351/items", ADMINU, { submission_id: "01J9XK2P0000000000000000ZZ" })).status).toBe(404);
    expect((await comp("POST", "/editions/9999/items", ADMINU, { submission_id: merged.id })).status).toBe(404);
    expect((await comp("POST", "/editions/1351/items", ADMINU, {})).status).toBe(400);
    expect(await counts()).toEqual(before);

    // wrong edition: merged.target_edition is 1351
    await db().prepare("INSERT INTO editions (ob_issue_no,status,created_at) VALUES (1400,'published','t')").run();
    expect((await comp("POST", "/editions/1400/items", ADMINU, { submission_id: merged.id })).status).toBe(409);
    await db().prepare("UPDATE submissions SET target_edition=1400 WHERE id=?1").bind(merged.id).run();
    expect((await comp("POST", "/editions/1400/items", ADMINU, { submission_id: merged.id })).status).toBe(409); // published edition
    await db().prepare("UPDATE submissions SET target_edition=1351 WHERE id=?1").bind(merged.id).run();
    expect(await stateOf(merged.id)).toBe("merged");
  });

  it("publish needs a composing edition with items, and a published edition cannot be published or changed", async () => {
    await comp("POST", "/editions", ADMINU, { ob_issue_no: 1351 });
    expect((await comp("POST", "/editions/1351/publish")).status).toBe(409); // open, nothing placed
    expect((await comp("POST", "/editions/7/publish")).status).toBe(404);
    const r = await toMerged();
    await comp("POST", "/editions/1351/items", ADMINU, { submission_id: r.id });
    const x = await toMerged("e212-mnc");
    expect((await comp("POST", "/editions/1351/publish")).status).toBe(200);
    const before = await counts();
    expect((await comp("POST", "/editions/1351/publish")).status).toBe(409);
    expect((await comp("POST", "/editions/1351/items", ADMINU, { submission_id: x.id })).status).toBe(409);
    expect((await comp("POST", `/editions/1351/items/${r.id}/remove`)).status).toBe(409);
    expect(await counts()).toEqual(before);
    expect(await stateOf(r.id)).toBe("published");
  });

  it("an edition staged by a pin bump refuses a late removal (the pin carries everything below it)", async () => {
    const r = await placed();
    await db().prepare("UPDATE editions SET status='staged'").run();
    expect((await comp("POST", `/editions/1351/items/${r.id}/remove`)).status).toBe(409);
    expect(await stateOf(r.id)).toBe("scheduled");
  });
});

describe("revert path: merged -> (revert PR merged) -> withdrawn", () => {
  it("admin withdraw of a merged submission opens ONE revert PR and changes nothing else until it merges", async () => {
    const r = await toMerged();
    expect((await adm(r.id, "withdraw", EDITOR, { reason: "x" })).status).toBe(403);
    expect((await adm(r.id, "withdraw", ADMINU, {})).status).toBe(400);
    const w = await adm(r.id, "withdraw", ADMINU, { reason: "entered in error" });
    expect([w.status, w.json.submission.state, w.json.revert.error]).toEqual([202, "merged", null]);
    expect(fake.closed).toHaveLength(0); // a merged PR is never "closed"
    expect(fake.revertRequests).toHaveLength(1);
    expect(fake.revertRequests[0]!.path).toBe(r.pr.path);
    const rv = await one("SELECT * FROM submission_reverts WHERE submission_id=?1", r.id);
    expect([rv.attempt, rv.pr_state, rv.pr_number, rv.reason, rv.branch === r.pr.branch]).toEqual([1, "open", w.json.revert.pr_number, "entered in error", false]);
    expect(rv.branch).toMatch(/^rt-sub-1351-001-e118-iin-revert1-[0-9A-Z]{8}$/);

    // a second click reuses the in-flight revert
    const again = await adm(r.id, "withdraw", ADMINU, { reason: "again" });
    expect([again.status, again.json.revert.pr_number]).toEqual([202, w.json.revert.pr_number]);
    expect(await n("SELECT count(*) n FROM submission_reverts")).toBe(1);
    expect(await n("SELECT count(*) n FROM review_state WHERE submission_id=?1 AND to_state='withdrawn'", r.id)).toBe(0);
    // it cannot be placed while the revert is open
    await comp("POST", "/editions", ADMINU, { ob_issue_no: 1351 });
    expect((await comp("POST", "/editions/1351/items", ADMINU, { submission_id: r.id })).status).toBe(409);

    // the merge webhook of THAT PR withdraws it
    const hk = await hook("pull_request", closedEvent(rv.repo, rv.branch, rv.pr_number, true));
    expect([hk.status, hk.json.from, hk.json.to]).toEqual([200, "merged", "withdrawn"]);
    expect(await stateOf(r.id)).toBe("withdrawn");
    const last = await one("SELECT actor_kind, from_state, to_state FROM review_state WHERE submission_id=?1 ORDER BY id DESC", r.id);
    expect(last).toEqual({ actor_kind: "github", from_state: "merged", to_state: "withdrawn" });
    expect((await one("SELECT pr_state, merge_sha FROM submission_reverts")).pr_state).toBe("merged");
    expect(await verifyChain(db())).toBeNull();
    expect((await adm(r.id, "withdraw", ADMINU, { reason: "late" })).status).toBe(409);
  });

  it("a revert merged into another base, or an unrelated PR number, does not withdraw", async () => {
    const r = await toMerged();
    await adm(r.id, "withdraw", ADMINU, { reason: "x" });
    const rv = await one("SELECT * FROM submission_reverts");
    expect((await hook("pull_request", closedEvent(rv.repo, rv.branch, rv.pr_number, true, "other"))).status).toBe(202);
    expect((await hook("pull_request", closedEvent(rv.repo, rv.branch, rv.pr_number + 50, true))).status).toBe(202);
    expect(await stateOf(r.id)).toBe("merged");
  });

  it("a revert PR closed unmerged leaves the submission merged and allows a new attempt on a new branch", async () => {
    const r = await toMerged();
    await adm(r.id, "withdraw", ADMINU, { reason: "x" });
    const one1 = await one("SELECT * FROM submission_reverts WHERE attempt=1");
    expect((await hook("pull_request", closedEvent(one1.repo, one1.branch, one1.pr_number, false))).status).toBe(200);
    expect(await stateOf(r.id)).toBe("merged");
    expect((await one("SELECT pr_state FROM submission_reverts WHERE attempt=1")).pr_state).toBe("closed");
    const w2 = await adm(r.id, "withdraw", ADMINU, { reason: "retry" });
    expect(w2.status).toBe(202);
    const two = await one("SELECT * FROM submission_reverts WHERE attempt=2");
    expect(two.branch).not.toBe(one1.branch);
    expect(two.branch).toMatch(/-revert2-/);
    // the old PR's merge event is for a superseded attempt: not ours any more
    expect((await hook("pull_request", closedEvent(one1.repo, one1.branch, one1.pr_number, true))).status).toBe(202);
    expect(await stateOf(r.id)).toBe("merged");
  });

  it("a GitHub failure while opening the revert is recorded, the submission stays merged, and the reconciler finishes it", async () => {
    const r = await toMerged();
    fake.failNextRevert = 1;
    const w = await adm(r.id, "withdraw", ADMINU, { reason: "x" });
    expect([w.status, w.json.revert.pr_number, w.json.revert.error]).toEqual([202, null, "GitHub 502"]);
    expect(await stateOf(r.id)).toBe("merged");
    expect((await one("SELECT last_error, pr_number FROM submission_reverts")).last_error).toBe("GitHub 502");
    const rep = await reconcile(db(), fake);
    expect(rep.repaired.map((x) => x.kind)).toEqual(["revert.opened"]);
    expect((await one("SELECT pr_state, pr_number, last_error FROM submission_reverts")).pr_state).toBe("open");
    expect(fake.revertRequests.length).toBe(2);
  });

  it("a published submission cannot be withdrawn; it is corrected by a follow-on with corrects_id", async () => {
    const r = await placed();
    expect((await comp("POST", "/editions/1351/publish")).status).toBe(200);
    const before = await counts();
    const w = await adm(r.id, "withdraw", ADMINU, { reason: "oops" });
    expect(w.status).toBe(409);
    expect(w.json.error).toMatch(/correction/);
    expect(fake.revertRequests).toHaveLength(0);
    expect(await counts()).toEqual(before);
    expect(await stateOf(r.id)).toBe("published");

    const body = (extra: object) => ({ register_id: "E118_IIN", slug: "e118-iin", action_type: "MOD", payload: { ...payload(), type: "MOD" }, ...extra });
    const c = await api("POST", "/api/me/submissions", { session: "member-A", body: body({ corrects_id: r.id }) });
    expect(c.status).toBe(201);
    expect(c.json.submission.corrects_id).toBe(r.id);
    expect(c.json.submission.state).toBe("draft");
    expect(await stateOf(r.id)).toBe("published"); // the original is untouched
    // only a published submission is corrected this way
    expect((await api("POST", "/api/me/submissions", { session: "member-A", body: body({ corrects_id: c.json.submission.id }) })).status).toBe(409);
    expect((await api("POST", "/api/me/submissions", { session: "member-A", body: body({ corrects_id: "01J9XK2P0000000000000000ZZ" }) })).status).toBe(400);
    expect((await api("POST", "/api/me/submissions", { session: "member-A", body: body({ corrects_id: "nope" }) })).status).toBe(400);
    expect((await api("POST", "/api/me/submissions", { session: "member-A", body: { ...body({ corrects_id: r.id }), register_id: "E212_MNC", slug: "e212-mnc", payload: { type: "MOD", data: { _class: "E212MNCAmendment", entries: [{ country_or_area: { en: "Aland" }, mcc_mnc_codes: "999 99" }] } } } })).status).toBe(400);
  });

  it("a scheduled submission is taken out of its edition before it can be withdrawn", async () => {
    const r = await placed();
    expect((await adm(r.id, "withdraw", ADMINU, { reason: "x" })).status).toBe(409);
    expect(fake.revertRequests).toHaveLength(0);
    await comp("POST", `/editions/1351/items/${r.id}/remove`);
    expect((await adm(r.id, "withdraw", ADMINU, { reason: "x" })).status).toBe(202);
  });
});

describe("reconciler: repairs a lost webhook, idempotently", () => {
  it("a PR merged upstream moves pr_open -> merged once; a second run and the late webhook change nothing", async () => {
    const r = await toPrOpen();
    fake.mergePr(r.pr.pr_number);
    const rep = await reconcile(db(), fake);
    expect(rep.repaired).toEqual([{ submission_id: r.id, kind: "pr.merged", from: "pr_open", to: "merged" }]);
    expect(await stateOf(r.id)).toBe("merged");
    const row = await one("SELECT pr_state, merge_sha FROM submission_prs WHERE submission_id=?1", r.id);
    expect(row).toEqual({ pr_state: "merged", merge_sha: "m".repeat(40) });
    const last = await one("SELECT actor_kind, from_state, to_state FROM review_state WHERE submission_id=?1 ORDER BY id DESC", r.id);
    expect(last).toEqual({ actor_kind: "github", from_state: "pr_open", to_state: "merged" });
    const after1 = await counts();
    const rep2 = await reconcile(db(), fake);
    expect([rep2.repaired, rep2.errors, rep2.checked]).toEqual([[], [], 0]);
    expect(await counts()).toEqual(after1);
    // the lost webhook finally arrives: ignored, no second transition
    const late = await hook("pull_request", closedEvent(r.pr.repo, r.pr.branch, r.pr.pr_number, true));
    expect(late.status).toBe(202);
    expect(await counts()).toEqual(after1);
    expect(await verifyChain(db())).toBeNull();
  });

  it("repairs ci_failed too, a PR closed unmerged, and leaves open PRs and the Worker's own closes alone", async () => {
    const a = await toPrOpen("e118-iin");
    const b = await toPrOpen("e212-mnc");
    const c = await toPrOpen("e218-trcc");
    await db().prepare("UPDATE submissions SET state='ci_failed' WHERE id=?1").bind(a.id).run();
    fake.mergePr(a.pr.pr_number);
    fake.closePr(b.pr.pr_number);
    // c stays open upstream
    const rep = await reconcile(db(), fake);
    expect(rep.repaired.map((x) => `${x.kind}:${x.from}>${x.to}`).sort()).toEqual(["pr.closed:pr_open>changes_requested", "pr.merged:ci_failed>merged"]);
    expect(await stateOf(c.id)).toBe("pr_open");

    const d = await toPrOpen("f32-tdi");
    await db().prepare("UPDATE submission_prs SET closing_at='t' WHERE submission_id=?1").bind(d.id).run();
    fake.closePr(d.pr.pr_number);
    expect((await reconcile(db(), fake)).repaired).toEqual([]);
    expect(await stateOf(d.id)).toBe("pr_open");
  });

  it("a PR merged into a base other than the data repo's base is not 'merged'", async () => {
    const r = await toPrOpen();
    fake.pullStates.set(r.pr.pr_number, { state: "closed", merged: true, mergeSha: "m".repeat(40), baseRef: "other" });
    expect((await reconcile(db(), fake)).repaired).toEqual([]);
    expect(await stateOf(r.id)).toBe("pr_open");
  });

  it("an unreadable PR is reported, changes nothing, and is repaired on the next run", async () => {
    const r = await toPrOpen();
    fake.mergePr(r.pr.pr_number);
    fake.failGet = true;
    const rep = await reconcile(db(), fake);
    expect(rep.errors).toEqual([{ submission_id: r.id, error: "GitHub 502 on read" }]);
    expect(await stateOf(r.id)).toBe("pr_open");
    fake.failGet = false;
    expect((await reconcile(db(), fake)).repaired).toHaveLength(1);
    expect(await stateOf(r.id)).toBe("merged");
  });

  it("a revert PR merged upstream withdraws the submission once; closed unmerged does not", async () => {
    const r = await toMerged();
    const w = await adm(r.id, "withdraw", ADMINU, { reason: "x" });
    expect((await reconcile(db(), fake)).repaired).toEqual([]); // still open
    fake.mergePr(w.json.revert.pr_number);
    const rep = await reconcile(db(), fake);
    expect(rep.repaired).toEqual([{ submission_id: r.id, kind: "revert.merged", from: "merged", to: "withdrawn" }]);
    expect(await stateOf(r.id)).toBe("withdrawn");
    const after = await counts();
    expect((await reconcile(db(), fake)).repaired).toEqual([]);
    expect(await counts()).toEqual(after);

    const s = await toMerged("e212-mnc");
    const w2 = await adm(s.id, "withdraw", ADMINU, { reason: "x" });
    fake.closePr(w2.json.revert.pr_number);
    expect((await reconcile(db(), fake)).repaired.map((x) => x.kind)).toEqual(["revert.closed"]);
    expect(await stateOf(s.id)).toBe("merged");
    expect((await reconcile(db(), fake)).repaired).toEqual([]);
  });

  it("is reachable only by an admin, over the Access-guarded route", async () => {
    const r = await toPrOpen();
    fake.mergePr(r.pr.pr_number);
    const res = await api("POST", "/api/admin/reconcile", { access: ADMINU, body: {} });
    expect([res.status, res.json.repaired.length]).toEqual([200, 1]);
    expect(await stateOf(r.id)).toBe("merged");
  });
});
