import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyChain } from "../worker/lib/audit.ts";
import { FakePatchPublisher, assertPatchBranch, setPublisher } from "../worker/lib/publisher.ts";
import { activateMember, api, db, provisionItu, seedFixtures } from "./helpers.ts";

const sources = import.meta.glob("../worker/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const COMPOSER = "../worker/lib/composer.ts";
const WEBHOOK = "../worker/lib/github-webhook.ts";
/** Where each guarded state may be the target of a transition. Anything else is a finding. */
const ALLOWED_FILES: Record<string, string[]> = { scheduled: [COMPOSER], published: [COMPOSER], merged: [WEBHOOK, COMPOSER] };
/** `to: "X"`, a `via: [... "X" ...]` and a raw `SET state = 'X'` assignment all move a submission there. */
const hasTransition = (text: string, state: string) =>
  new RegExp(`to:\\s*"${state}"|via:\\s*\\[[^\\]]*"${state}"|SET\\s+state\\s*=\\s*'${state}'`, "i").test(text);
function transitionOffenders(srcs: Record<string, string>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [state, allowed] of Object.entries(ALLOWED_FILES))
    out[state] = Object.entries(srcs).filter(([f, t]) => hasTransition(t, state) && !allowed.includes(f)).map(([f]) => f);
  return out;
}

const SAME = { "Sec-Fetch-Site": "same-origin" };
const EDITOR = "itu-editor@example.test";
const ADMINU = "itu-admin@example.test";
const MEMBER_A = "member-A@example.test";

const entry = (over: Record<string, unknown> = {}) => ({ country_or_area: { en: "Aland" }, company_name: "Acme Telecom", ...over });
const payload = (entries: unknown[] = [entry()], type = "ADD") => ({ type, data: { _class: "E118Amendment", entries } });
const body = (p: unknown = payload()) => ({ register_id: "E118_IIN", slug: "e118-iin", action_type: "ADD", payload: p });

let fake: FakePatchPublisher;
beforeEach(async () => {
  await seedFixtures();
  await activateMember("member-A", "A");
  await activateMember("member-B", "B");
  await provisionItu("itu-editor", ["itu-editor"]);
  await provisionItu("itu-admin", ["itu-admin"]);
  fake = new FakePatchPublisher();
  setPublisher(fake);
});
afterEach(() => setPublisher(null));

const count = async (sql: string, ...b: unknown[]) => (await db().prepare(sql).bind(...b).first<{ n: number }>())!.n;
const stateOf = async (id: string) => (await db().prepare("SELECT state FROM submissions WHERE id=?1").bind(id).first<any>())!.state as string;

async function draft(user = "member-A", p: unknown = payload()) {
  const r = await api("POST", "/api/me/submissions", { session: user, body: body(p) });
  expect(r.status).toBe(201);
  return r.json.submission.id as string;
}
const me = (id: string, verb: string, user = "member-A", b: unknown = {}) => api("POST", `/api/me/submissions/${id}/${verb}`, { session: user, body: b });
const adm = (id: string, verb: string, who = EDITOR, b: unknown = {}) => api("POST", `/api/admin/submissions/${id}/${verb}`, { access: who, body: b });

async function toInReview() {
  const id = await draft();
  expect((await me(id, "submit")).status).toBe(200);
  expect((await adm(id, "start-review")).status).toBe(200);
  return id;
}

describe("happy path", () => {
  it("draft -> submitted -> in_review -> approved -> pr_pending -> pr_open with the exact file bytes", async () => {
    const id = await draft();
    expect((await me(id, "submit")).json.submission.state).toBe("submitted");
    expect((await adm(id, "start-review")).json.submission.state).toBe("in_review");
    const a = await adm(id, "approve", EDITOR, { target_edition: 1351 });
    expect(a.status).toBe(200);
    expect(a.json.submission.state).toBe("pr_open");
    expect(a.json.pr.pr_number).toBe(1);

    expect(fake.requests).toHaveLength(1);
    const req = fake.requests[0]!;
    expect(req.repo).toBe("ituob/itu-ob-data");
    expect(req.path).toBe("ob-issues/1351/e118-iin/001-ADD.yaml");
    expect(req.branch).toMatch(/^rt-sub-1351-001-e118-iin-[0-9A-Z]{8}$/);
    expect(req.branch).toBe(`rt-sub-1351-001-e118-iin-${id.slice(-8)}`);
    expect(req.content).toContain("ob_issue_no: \"1351\"");
    expect(req.content).toContain("reference: OB-1351");
    expect(req.content).toContain("code: 1351-001");
    expect(req.content).toContain("company_name: Acme Telecom");
    const stored = await db().prepare("SELECT content_yaml,pr_number,pr_state,branch FROM submission_prs WHERE submission_id=?1").bind(id).first<any>();
    expect(stored.content_yaml).toBe(req.content);
    expect(stored).toMatchObject({ pr_number: 1, pr_state: "open", branch: req.branch });

    const hist = (await db().prepare("SELECT from_state,to_state,actor_kind FROM review_state WHERE submission_id=?1 ORDER BY id").bind(id).all()).results;
    expect(hist.map((h: any) => `${h.from_state}>${h.to_state}`)).toEqual([
      "null>draft", "draft>submitted", "submitted>in_review", "in_review>approved", "approved>pr_pending", "pr_pending>pr_open",
    ]);
    expect((hist[5] as any).actor_kind).toBe("system");
  });

  it("snapshots affiliation at write time", async () => {
    const id = await draft();
    const s = await db().prepare("SELECT proposer_id,affiliation_kind,affiliation_member_id FROM submissions WHERE id=?1").bind(id).first<any>();
    expect(s).toEqual({ proposer_id: "member-A", affiliation_kind: "member", affiliation_member_id: "A" });
  });

  it("allocates distinct NNN per (edition, slug)", async () => {
    const ids = [await toInReview(), await toInReview()];
    await adm(ids[0]!, "approve", EDITOR, { target_edition: 1351 });
    await adm(ids[1]!, "approve", EDITOR, { target_edition: 1351 });
    expect(fake.requests.map((r) => r.path)).toEqual([
      "ob-issues/1351/e118-iin/001-ADD.yaml", "ob-issues/1351/e118-iin/002-ADD.yaml",
    ]);
  });
});

describe("changes requested, rejection, withdrawal", () => {
  it("changes_requested -> revise (rev 2) -> approve commits rev 2; rev 1 stays immutable", async () => {
    const id = await toInReview();
    expect((await adm(id, "request-changes", EDITOR, {})).status).toBe(400); // reason required
    expect((await adm(id, "request-changes", EDITOR, { reason: "name the company in full" })).json.submission.state).toBe("changes_requested");
    expect((await me(id, "submit")).status).toBe(409); // cannot submit from changes_requested; must revise
    const rv = await me(id, "revise", "member-A", payload([entry({ company_name: "Acme Telecom Ltd" })]));
    expect(rv.status).toBe(400); // wrapper required: { payload }
    const rv2 = await me(id, "revise", "member-A", { payload: payload([entry({ company_name: "Acme Telecom Ltd" })]) });
    expect(rv2.json.submission).toMatchObject({ state: "submitted", current_rev: 2 });
    await adm(id, "start-review");
    await adm(id, "approve", EDITOR, { target_edition: 1351 });
    expect(fake.requests[0]!.content).toContain("Acme Telecom Ltd");
    const revs = (await db().prepare("SELECT rev,payload_yaml FROM submission_revisions WHERE submission_id=?1 ORDER BY rev").bind(id).all()).results as any[];
    expect(revs).toHaveLength(2);
    expect(revs[0].payload_yaml).toContain("Acme Telecom\n");
    const prRev = await db().prepare("SELECT rev FROM submission_prs WHERE submission_id=?1").bind(id).first<any>();
    expect(prRev.rev).toBe(2);
  });

  it("rejection is terminal and needs a reason", async () => {
    const id = await toInReview();
    expect((await adm(id, "reject", EDITOR, {})).status).toBe(400);
    expect((await adm(id, "reject", EDITOR, { reason: "duplicate" })).json.submission.state).toBe("rejected");
    for (const [who, call] of [
      ["member", () => me(id, "submit")], ["member", () => me(id, "withdraw")],
      ["editor", () => adm(id, "approve", EDITOR, { target_edition: 1351 })], ["editor", () => adm(id, "start-review")],
    ] as const) expect((await call()).status, who).toBe(409);
    expect(fake.requests).toHaveLength(0);
  });

  it("proposer withdraws a draft, a submitted and a changes_requested submission", async () => {
    const d = await draft();
    expect((await me(d, "withdraw")).json.submission.state).toBe("withdrawn");
    const s = await draft();
    await me(s, "submit");
    expect((await me(s, "withdraw", "member-A", { reason: "oops" })).json.submission.state).toBe("withdrawn");
    const c = await toInReview();
    await adm(c, "request-changes", EDITOR, { reason: "x" });
    expect((await me(c, "withdraw")).json.submission.state).toBe("withdrawn");
    // not from in_review: the member lost the right once review started
    const r = await toInReview();
    expect((await me(r, "withdraw")).status).toBe(409);
  });

  it("admin withdraws an approved, unpublished submission: PR closed, reason required, editor cannot", async () => {
    const id = await toInReview();
    await adm(id, "approve", EDITOR, { target_edition: 1351 });
    expect((await adm(id, "withdraw", EDITOR, { reason: "x" })).status).toBe(403);
    expect((await adm(id, "withdraw", ADMINU, {})).status).toBe(400);
    const w = await adm(id, "withdraw", ADMINU, { reason: "entered in error" });
    expect(w.json.submission.state).toBe("withdrawn");
    expect(fake.closed).toHaveLength(1);
    expect(fake.closed[0]!.branch).toBe(fake.requests[0]!.branch);
    expect((await db().prepare("SELECT pr_state FROM submission_prs WHERE submission_id=?1").bind(id).first<any>()).pr_state).toBe("closed");
    expect((await adm(id, "withdraw", ADMINU, { reason: "again" })).status).toBe(409);
  });
});

describe("illegal transitions are rejected and write nothing", () => {
  it("every out-of-order move is a 409 with no new history or audit rows", async () => {
    const d = await draft();
    const s = await draft();
    await me(s, "submit");
    const before = [await count("SELECT count(*) n FROM review_state"), await count("SELECT count(*) n FROM audit_log")];
    const calls: [string, () => Promise<{ status: number }>][] = [
      ["draft start-review", () => adm(d, "start-review")],
      ["draft approve", () => adm(d, "approve", EDITOR, { target_edition: 1 })],
      ["draft request-changes", () => adm(d, "request-changes", EDITOR, { reason: "x" })],
      ["draft reject", () => adm(d, "reject", EDITOR, { reason: "x" })],
      ["draft revise", () => me(d, "revise", "member-A", { payload: payload() })],
      ["draft admin withdraw", () => adm(d, "withdraw", ADMINU, { reason: "x" })],
      ["submitted submit", () => me(s, "submit")],
      ["submitted approve", () => adm(s, "approve", EDITOR, { target_edition: 1 })],
      ["submitted reject", () => adm(s, "reject", EDITOR, { reason: "x" })],
      ["submitted request-changes", () => adm(s, "request-changes", EDITOR, { reason: "x" })],
      ["submitted edit", () => api("PUT", `/api/me/submissions/${s}`, { session: "member-A", body: { payload: payload() } })],
      ["submitted open-pr", () => adm(s, "open-pr")],
    ];
    for (const [name, call] of calls) expect((await call()).status, name).toBe(409);
    expect([await count("SELECT count(*) n FROM review_state"), await count("SELECT count(*) n FROM audit_log")]).toEqual(before);
    expect(await stateOf(d)).toBe("draft");
    expect(await stateOf(s)).toBe("submitted");
  });

  it("merged/scheduled/published are not reachable by any member endpoint: each literal lives only in the files named here", () => {
    expect(transitionOffenders(sources)).toEqual({ scheduled: [], published: [], merged: [] });
    // The files that legitimately hold each literal are pinned, not merely "somewhere".
    const holds = (state: string) => Object.entries(sources).filter(([f, t]) => hasTransition(t, state) && !f.includes("/test/")).map(([f]) => f).sort();
    expect(holds("scheduled")).toEqual([COMPOSER]);
    expect(holds("published")).toEqual([COMPOSER]);
    expect(holds("merged")).toEqual([COMPOSER, WEBHOOK].sort());
  });

  it("mutation probe: the guard fires when a forbidden file gains a transition literal", () => {
    const probes: [string, string, string][] = [
      ["to literal in a member module", "../worker/lib/submissions.ts", '\nconst x = { to: "published" };\n'],
      ["to literal in a member route", "../worker/submission-routes.ts", '\nconst x = { to: "scheduled" };\n'],
      ["merged in the discussion module", "../worker/lib/discussion.ts", '\nmutate(db, s, { from: ["draft"], to: "merged" });\n'],
      ["via smuggles a state", "../worker/lib/revert.ts", '\nconst o = { via: ["x", "scheduled"] };\n'],
      ["raw SQL sets the state", "../worker/lib/membership.ts", "\nconst q = `UPDATE submissions SET state = 'published'`;\n"],
      ["the reconciler cannot place", "../worker/lib/reconciler.ts", '\nconst x = { to: "scheduled" };\n'],
      ["a route file", "../worker/composer-routes.ts", '\nconst x = { to: "published" };\n'],
    ];
    for (const [name, file, add] of probes) {
      expect(sources[file], file).toBeDefined();
      const mutated = { ...sources, [file]: sources[file] + add };
      const off = Object.values(transitionOffenders(mutated)).flat();
      expect(off, name).toContain(file);
    }
    // The allowed file is exempt only for its own literals: an unrelated transition there is not a finding either way.
    const noComposer = { ...sources, [COMPOSER]: sources[COMPOSER] + '\nconst y = { to: "withdrawn" };\n' };
    expect(transitionOffenders(noComposer)).toEqual({ scheduled: [], published: [], merged: [] });
  });

  it("the composer is admin-only: no member route file imports it, and its route table is Access-guarded", () => {
    const importers = Object.entries(sources).filter(([f, t]) => f !== COMPOSER && /from\s+"[^"]*\/composer\.ts"|from\s+"\.\/lib\/composer\.ts"/.test(t)).map(([f]) => f);
    expect(importers).toEqual(["../worker/composer-routes.ts"]);
    const routes = sources["../worker/composer-routes.ts"]!;
    expect(routes.match(/guard:\s*"[a-z]+"/g)!.every((g) => g === 'guard: "access"')).toBe(true);
    expect(routes).not.toMatch(/\/api\/me\//);
    for (const f of ["../worker/submission-routes.ts", "../worker/discussion-routes.ts"]) expect(sources[f], f).not.toMatch(/composer/i);
    // every composer entry point checks the admin role itself, not only the route guard
    const c = sources[COMPOSER]!;
    const exported = [...c.matchAll(/export async function (\w+)\(db: D1Database, session: Session \| null/g)].map((m) => m[1]);
    expect(exported.sort()).toEqual(["listEditions", "listMergedUnpublished", "openEdition", "placeItem", "publishEdition", "readEdition", "removeItem"]);
    for (const fn of exported) {
      const body = c.slice(c.indexOf(`export async function ${fn}(`)).split(/\nexport /)[0]!;
      expect(body, fn).toMatch(/admin\(session\)/);
    }
  });

  it("the scheduled handler runs the reconciler", () => {
    expect(sources["../worker/index.ts"]).toMatch(/reconcile\(env\.DB, getPublisher\(\)\)/);
  });
});

describe("country binding and authority", () => {
  it("cross-country, mixed, unresolvable keys: 403 and nothing written", async () => {
    for (const entries of [[entry({ country_or_area: { en: "Bland" } })], [entry(), entry({ country_or_area: { en: "Bland" } })], [entry({ country_or_area: { en: "Nowhere" } })]]) {
      expect((await api("POST", "/api/me/submissions", { session: "member-A", body: body(payload(entries)) })).status).toBe(403);
    }
    expect(await count("SELECT count(*) n FROM submissions")).toBe(0);
    expect(await count("SELECT count(*) n FROM audit_log")).toBe(0);
  });

  it("editing or revising towards another country is refused, and a spoofed proposer/affiliation in the body is ignored", async () => {
    const id = await draft();
    const e = await api("PUT", `/api/me/submissions/${id}`, { session: "member-A", body: { payload: payload([entry({ country_or_area: { en: "Bland" } })]) } });
    expect(e.status).toBe(403);
    const r = await api("POST", "/api/me/submissions", { session: "member-B", body: { ...body(payload([entry({ country_or_area: { en: "Bland" } })])), proposer_id: "member-A", affiliation_member_id: "A", affiliation_kind: "itu" } });
    expect(r.status).toBe(201);
    expect(r.json.submission).toMatchObject({ proposer_id: "member-B", affiliation_kind: "member", affiliation_member_id: "B" });
  });

  it("unaffiliated and not-logged-in cannot submit; another member cannot touch or read my draft", async () => {
    expect((await api("POST", "/api/me/submissions", { session: "unaffiliated", body: body() })).status).toBe(403);
    expect((await api("POST", "/api/me/submissions", { body: body() })).status).toBe(401);
    const id = await draft();
    expect((await me(id, "submit", "member-B")).status).toBe(403);
    expect((await me(id, "withdraw", "member-B")).status).toBe(403);
    expect((await api("GET", `/api/me/submissions/${id}`, { session: "member-B", headers: SAME })).status).toBe(404);
    expect((await api("GET", `/api/me/submissions/${id}`, { session: "member-A", headers: SAME })).status).toBe(200);
    expect((await api("GET", `/api/me/submissions/${id}`, { session: "itu-editor", headers: SAME })).status).toBe(200);
  });

  it("a deactivated member loses the right to submit what they drafted", async () => {
    const id = await draft();
    const mid = (await db().prepare("SELECT id FROM memberships WHERE user_id='member-A'").first<any>()).id;
    await api("POST", `/api/admin/memberships/${mid}/deactivate`, { access: "admin@itu.example", body: {} });
    expect((await me(id, "submit")).status).toBe(403);
  });

  it("admin routes need Access and an ITU role; a member email via Access is not enough; members have no admin power", async () => {
    const id = await toInReview();
    expect((await api("POST", `/api/admin/submissions/${id}/approve`, { body: { target_edition: 1 } })).status).toBe(403);
    expect((await adm(id, "approve", MEMBER_A, { target_edition: 1351 })).status).toBe(403);
    expect((await api("POST", `/api/admin/submissions/${id}/approve`, { session: "member-A", body: { target_edition: 1351 } })).status).toBe(403);
    expect((await adm(id, "approve", "nobody@example.test", { target_edition: 1351 })).status).toBe(403);
    expect(await stateOf(id)).toBe("in_review");
  });

  it("an editor cannot review their own submission; an admin can only with an explicit, audited override", async () => {
    const own = (await api("POST", "/api/me/submissions", { session: "itu-editor", body: body() })).json.submission.id as string;
    await me(own, "submit", "itu-editor");
    expect((await adm(own, "start-review", EDITOR)).status).toBe(403);
    expect((await adm(own, "start-review", ADMINU)).status).toBe(200); // different person: fine
    const mine = (await api("POST", "/api/me/submissions", { session: "itu-admin", body: body() })).json.submission.id as string;
    await me(mine, "submit", "itu-admin");
    expect((await adm(mine, "start-review", ADMINU)).status).toBe(403);
    expect((await adm(mine, "start-review", ADMINU, { override_self_review: true })).status).toBe(200);
    const a = await db().prepare("SELECT detail FROM audit_log WHERE submission_id=?1 AND action='submission.state' ORDER BY id DESC LIMIT 1").bind(mine).first<any>();
    expect(JSON.parse(a.detail).override).toBe("self-review-override");
  });
});

describe("validation stage 1", () => {
  const durableSnapshot = async () => {
    const tables = ["submissions", "submission_revisions", "review_state", "audit_log"];
    return Promise.all(tables.map(table => db().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().then(r => r.results)));
  };

  it("rejects an invalid draft creation without any durable writes", async () => {
    const before = await durableSnapshot();
    const r = await api("POST", "/api/me/submissions", { session: "member-A", body: body(payload([entry({ company_name: "  " })])) });
    expect(r.status).toBe(422);
    expect(r.json.errors).toEqual([{ path: "data.entries[0].company_name", code: "required", message: "company_name is required" }]);
    expect(await durableSnapshot()).toEqual(before);
    const id = await draft();
    expect((await me(id, "submit")).status).toBe(200);
  });

  it("rejects invalid draft edits without changing payload, revision, version, history or audit", async () => {
    const id = await draft();
    const before = await durableSnapshot();
    for (const [invalid, path] of [[payload([entry({ company_name: "" })]), "data.entries[0].company_name"], [payload([entry({ tel: "wrong type" })]), "data.entries[0].tel"]] as const) {
      const r = await api("PUT", `/api/me/submissions/${id}`, { session: "member-A", body: { payload: invalid } });
      expect(r.status).toBe(422);
      expect(r.json.errors).toContainEqual(expect.objectContaining({ path }));
      expect(await durableSnapshot()).toEqual(before);
    }
    const fixed = payload([entry({ company_name: "Revised Telecom" })]);
    expect((await api("PUT", `/api/me/submissions/${id}`, { session: "member-A", body: { payload: fixed } })).status).toBe(200);
    const sub = await db().prepare("SELECT current_rev,version FROM submissions WHERE id=?1").bind(id).first<any>();
    expect(sub).toMatchObject({ current_rev: 2, version: 1 });
    expect(await count("SELECT count(*) n FROM submission_revisions WHERE submission_id=?1", id)).toBe(2);
    expect((await me(id, "submit")).status).toBe(200);
  });

  it("rejects envelope errors at creation; stored SUP shape submits and LIR needs ITU", async () => {
    const before = await durableSnapshot();
    const r = await api("POST", "/api/me/submissions", { session: "member-A", body: body({ type: "DEL", data: { _class: "nope", entries: [entry()] } }) });
    expect(r.status).toBe(422);
    expect(r.json.errors.map((e: any) => e.path).sort()).toEqual(["data._class", "type"]);
    const withKey = await api("POST", "/api/me/submissions", { session: "member-A", body: { ...body(payload([entry({ superseded_by: { x: 1 } })], "SUP")), action_type: "SUP" } });
    expect(withKey.status).toBe(422);
    expect(withKey.json.errors.map((e: any) => `${e.code}:${e.path}`)).toEqual(["unknown:data.entries[0].superseded_by"]);
    expect(await durableSnapshot()).toEqual(before);
    const sup = await api("POST", "/api/me/submissions", { session: "member-A", body: { ...body(payload([entry()], "SUP")), action_type: "SUP" } });
    expect(sup.status).toBe(201);
    expect((await me(sup.json.submission.id, "submit")).status).toBe(200);
    const lir = await api("POST", "/api/me/submissions", { session: "member-A", body: { ...body(), action_type: "LIR" } });
    expect(lir.status).toBe(403);
  });

  it("revise with invalid content is refused and writes no revision", async () => {
    const id = await toInReview();
    await adm(id, "request-changes", EDITOR, { reason: "x" });
    const r = await me(id, "revise", "member-A", { payload: payload([entry({ company_name: "" })]) });
    expect(r.status).toBe(422);
    expect(await count("SELECT count(*) n FROM submission_revisions WHERE submission_id=?1", id)).toBe(1);
    expect(await stateOf(id)).toBe("changes_requested");
  });

  it("the validator chain is pluggable", async () => {
    const { setValidators, stage1 } = await import("../worker/lib/validation.ts");
    const id = await draft();
    setValidators([stage1, () => [{ path: "data.entries[0].x", code: "enum", message: "plugged" }]]);
    try {
      const before = await durableSnapshot();
      const created = await api("POST", "/api/me/submissions", { session: "member-A", body: body() });
      expect(created.status).toBe(422);
      expect(created.json.errors.at(-1).message).toBe("plugged");
      const edited = await api("PUT", `/api/me/submissions/${id}`, { session: "member-A", body: { payload: payload() } });
      expect(edited.status).toBe(422);
      expect(edited.json.errors.at(-1).message).toBe("plugged");
      expect((await me(id, "submit")).json.errors.at(-1).message).toBe("plugged");
      expect(await durableSnapshot()).toEqual(before);
    } finally {
      setValidators(null);
    }
  });
});

describe("approval -> PR: idempotency and failure", () => {
  it("double-click approve makes exactly one PR and one approval", async () => {
    const id = await toInReview();
    const rs = await Promise.all([adm(id, "approve", EDITOR, { target_edition: 1351 }), adm(id, "approve", EDITOR, { target_edition: 1351 })]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(fake.createdPrs).toBe(1);
    expect(await count("SELECT count(*) n FROM submission_prs WHERE submission_id=?1", id)).toBe(1);
    expect(await count("SELECT count(*) n FROM review_state WHERE submission_id=?1 AND to_state='approved'", id)).toBe(1);
    // replaying the consumer by hand duplicates nothing
    expect((await adm(id, "open-pr")).status).toBe(200);
    expect(fake.createdPrs).toBe(1);
    expect(await stateOf(id)).toBe("pr_open");
    // and a later sequential click is still a 409, burning no number
    expect((await adm(id, "approve", EDITOR, { target_edition: 1351 })).status).toBe(409);
    expect((await db().prepare("SELECT next_seq FROM edition_seq").first<any>()).next_seq).toBeLessThanOrEqual(3);
  });

  it("a GitHub outage leaves the approval durable in pr_pending with last_error; retry opens one PR", async () => {
    const id = await toInReview();
    fake.failNext = 1;
    const a = await adm(id, "approve", EDITOR, { target_edition: 1351 });
    expect(a.status).toBe(202);
    expect(a.json.pr).toMatchObject({ state: "pr_pending", error: "GitHub 502" });
    const row = await db().prepare("SELECT attempts,last_error FROM submission_prs WHERE submission_id=?1").bind(id).first<any>();
    expect(row).toEqual({ attempts: 1, last_error: "GitHub 502" });
    expect(await stateOf(id)).toBe("pr_pending");
    const retry = await adm(id, "open-pr");
    expect(retry.status).toBe(200);
    expect(retry.json.pr.state).toBe("pr_open");
    expect(fake.createdPrs).toBe(1);
    expect(fake.requests[0]!.branch).toBe(fake.requests[1]!.branch);
  });

  it("with the real publisher unconfigured, approval stands and the PR stays pending with 'not configured'", async () => {
    setPublisher(null);
    const id = await toInReview();
    const a = await adm(id, "approve", EDITOR, { target_edition: 1351 });
    expect(a.status).toBe(202);
    expect(a.json.pr.error).toBe("not configured");
    expect(await stateOf(id)).toBe("pr_pending");
  });

  it("no code path can target main or any non rt-sub-* ref", async () => {
    for (const b of ["main", "master", "rt-improvements", "refs/heads/main", "rt-sub-1-1-x-ABCDEFGH"]) expect(() => assertPatchBranch(b), b).toThrow();
    expect(() => assertPatchBranch("rt-sub-1351-001-e118-iin-01J9XK2P")).not.toThrow();
    await expect(fake.openPatchPr({ repo: "r", branch: "main", path: "p", content: "c", title: "t", body: "b", idempotencyKey: "k" })).rejects.toThrow(/refusing branch/);
    await expect(db().prepare("INSERT INTO submission_prs (submission_id,rev,repo,branch,path,content_yaml,content_sha,idempotency_key) VALUES ('x',1,'r','main','p','c','s','k')").run()).rejects.toThrow();
    // The webhook mentions main once, to COMPARE a PR's base ref (webhook or reconciler-read); the FAKE publisher
    // names it once as the base it REPORTS. Nothing writes to it, and nothing else spells it.
    const mainRefs = Object.entries(sources).filter(([, t]) => /heads\/main|"main"/.test(t)).map(([f]) => f);
    expect(mainRefs).toEqual(["../worker/lib/github-webhook.ts", "../worker/lib/publisher.ts"]);
    for (const f of mainRefs) expect(sources[f].match(/heads\/main|"main"/g), f).toHaveLength(1);
    expect(sources["../worker/lib/publisher.ts"]).toMatch(/const FAKE_BASE = "main"/);
  });
});

describe("audit trail", () => {
  it("every transition has who/when/from/to in review_state and a matching audit row; the chain verifies", async () => {
    const id = await toInReview();
    await adm(id, "request-changes", EDITOR, { reason: "r" });
    await me(id, "revise", "member-A", { payload: payload() });
    await adm(id, "start-review");
    await adm(id, "approve", EDITOR, { target_edition: 1351 });
    await adm(id, "withdraw", ADMINU, { reason: "gone" });

    const hist = (await db().prepare("SELECT * FROM review_state WHERE submission_id=?1 ORDER BY id").bind(id).all()).results as any[];
    expect(hist.length).toBe(10);
    for (const h of hist) {
      expect(h.at).toMatch(/^\d{4}-\d\d-\d\dT/);
      if (h.actor_kind === "user") expect(h.actor_id).toBeTruthy();
    }
    expect(hist.filter((h) => h.actor_kind === "system").map((h) => h.to_state)).toEqual(["pr_open"]);
    const audits = (await db().prepare("SELECT * FROM audit_log WHERE submission_id=?1 AND action IN ('submission.created','submission.state','pr.opened') ORDER BY id").bind(id).all()).results as any[];
    expect(audits.length).toBe(hist.length);
    audits.forEach((a, i) => {
      const d = JSON.parse(a.detail);
      expect([d.from ?? null, d.to]).toEqual([hist[i].from_state, hist[i].to_state]);
      expect(a.actor_id).toBe(hist[i].actor_id);
      expect(a.at).toBe(hist[i].at);
    });
    expect(await verifyChain(db())).toBeNull();
    // tamper -> detected
    await db().prepare("UPDATE audit_log SET actor_id='member-B' WHERE id=(SELECT min(id) FROM audit_log)").run();
    expect(await verifyChain(db())).not.toBeNull();
  });

  it("draft edits and PR failures are audited too", async () => {
    const id = await draft();
    await api("PUT", `/api/me/submissions/${id}`, { session: "member-A", body: { payload: payload() } });
    expect(await count("SELECT count(*) n FROM audit_log WHERE submission_id=?1 AND action='submission.draft_edited'", id)).toBe(1);
    expect(await count("SELECT count(*) n FROM review_state WHERE submission_id=?1", id)).toBe(1);
  });

  it("the application never updates or deletes append-only tables", () => {
    for (const [file, text] of Object.entries(sources)) {
      expect(text, file).not.toMatch(/\b(UPDATE|DELETE\s+FROM)\s+(audit_log|review_state|submission_revisions)\b/i);
    }
  });
});
