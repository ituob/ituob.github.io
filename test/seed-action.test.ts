import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakePatchPublisher, setPublisher } from "../worker/lib/publisher.ts";
import { FakeRepoReader, GitHubContentsReader, RepoReadFailed, RepoReaderNotConfigured, getRepoReader, registerIsEmpty, setRepoReader } from "../worker/lib/repo-reader.ts";
import { activateMember, api, db, provisionItu, seedFixtures } from "./helpers.ts";

const entry = (n: string) => ({ country_or_area: { en: "Aland" }, company_name: `Acme ${n}`, issue_id_number: `89 358 ${n}` });
const seed = (entries = [entry("01"), entry("02")]) => ({ register_id: "E118_IIN", slug: "e118-iin", action_type: "SEED", payload: { type: "SEED", data: { _class: "E118Amendment", entries } } });
const REPO = "ituob/service-publications-docs";
/** What the data repository says about E.118: `datasets.yaml` plus the dataset's `changes/` directory. */
const datasets = (flags: { file: boolean; dir?: boolean }) => `datasets:\n- directory: 1161-E.118\n  title: E.118\n  has_data_file: ${flags.file}\n  has_data_directory: ${flags.dir ?? false}\n`;
const emptyRegister = () => ({ [`${REPO}:datasets.yaml`]: datasets({ file: false }) });
const populate = (r: FakeRepoReader) => r.set(REPO, "datasets.yaml", datasets({ file: true }));
const READS = [`${REPO}:datasets.yaml`, `${REPO}:datasets/1161-E.118/changes/`];
let reader: FakeRepoReader;
beforeEach(async () => {
  await seedFixtures();
  await activateMember("member-A", "A");
  await provisionItu("itu-editor", ["itu-editor"]);
  await provisionItu("itu-admin", ["itu-admin"]);
  setPublisher(new FakePatchPublisher());
  reader = new FakeRepoReader(emptyRegister());
  setRepoReader(reader);
});
afterEach(() => { setPublisher(null); setRepoReader(null); });
const create = (who: string, b: unknown = seed()) => api("POST", "/api/me/submissions", { session: who, body: b });

describe("staff-only SEED", () => {
  it("is stored for ITU staff on an empty register, with its schema-validated full payload", async () => {
    const r = await create("itu-editor");
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.submission.action_type).toBe("SEED");
    expect(reader.reads).toEqual(READS);
  });
  it("is refused for a member session, before any repository read", async () => {
    expect((await create("member-A")).status).toBe(403);
    expect(reader.reads).toEqual([]);
  });
  it("is refused with a conflict when the register already has state", async () => {
    populate(reader);
    const r = await create("itu-editor");
    expect(r.status).toBe(409);
    expect((await db().prepare("SELECT count(*) n FROM submissions").first<{ n: number }>())!.n).toBe(0);
  });
  it("fails closed when the repository cannot be read or is not configured", async () => {
    setRepoReader(null);
    expect((await create("itu-editor")).status).toBe(503);
    const failing = async () => { throw new RepoReadFailed("GitHub read failed (500)"); };
    setRepoReader({ read: failing, list: failing });
    expect((await create("itu-editor")).status).toBe(502);
  });
  it("still rejects an invalid SEED payload and keeps other actions off the reader", async () => {
    expect((await create("itu-editor", seed([]))).status).toBe(422);
    expect(reader.reads).toEqual([]);
    const add = { register_id: "E118_IIN", slug: "e118-iin", action_type: "ADD", payload: { type: "ADD", data: { _class: "E118Amendment", entries: [entry("03")] } } };
    expect((await create("member-A", add)).status).toBe(201);
    expect(reader.reads).toEqual([]);
  });
  it("re-checks emptiness at approval, so a register seeded meanwhile cannot take a second SEED", async () => {
    const id = (await create("itu-editor")).json.submission.id;
    expect((await api("POST", `/api/me/submissions/${id}/submit`, { session: "itu-editor", body: {} })).status).toBe(200);
    expect((await api("POST", `/api/admin/submissions/${id}/start-review`, { access: "itu-admin@example.test", body: {} })).status).toBe(200);
    populate(reader);
    const r = await api("POST", `/api/admin/submissions/${id}/approve`, { access: "itu-admin@example.test", body: { target_edition: 1400 } });
    expect(r.status).toBe(409);
  });
  it("allows one SEED per register: a second is refused at create, and at approval if one slipped in", async () => {
    expect((await create("itu-editor")).status).toBe(201);
    const second = await create("itu-editor");
    expect(second.status).toBe(409);
    expect((await db().prepare("SELECT count(*) n FROM submissions WHERE action_type='SEED'").first<{ n: number }>())!.n).toBe(1);
    // A SEED that was never rejected or withdrawn also blocks approving another one.
    const first = (await db().prepare("SELECT id FROM submissions").first<{ id: string }>())!.id;
    const now = new Date().toISOString();
    await db().prepare(`INSERT INTO submissions (id,proposer_id,affiliation_kind,register_id,slug,action_type,state,current_rev,created_at,updated_at,version)
      SELECT ?1,proposer_id,'itu',register_id,slug,'SEED','in_review',1,?2,?2,0 FROM submissions WHERE id=?3`).bind("01ARZ3NDEKTSV4RRFFQ69G5FAV", now, first).run();
    const r = await api("POST", "/api/admin/submissions/01ARZ3NDEKTSV4RRFFQ69G5FAV/approve", { access: "itu-admin@example.test", body: { target_edition: 1400 } });
    expect(r.status).toBe(409);
    expect(String(r.json.error)).toMatch(/SEED in progress/);
  });
  it("a withdrawn SEED does not block a new one", async () => {
    const id = (await create("itu-editor")).json.submission.id;
    expect((await api("POST", `/api/me/submissions/${id}/withdraw`, { session: "itu-editor", body: {} })).status).toBe(200);
    expect((await create("itu-editor")).status).toBe(201);
  });
  it("the rebuilt table keeps child rows and foreign keys intact", async () => {
    const id = (await create("itu-editor")).json.submission.id;
    expect((await db().prepare("SELECT count(*) n FROM submission_revisions WHERE submission_id=?1").bind(id).first<{ n: number }>())!.n).toBe(1);
    expect((await db().prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    expect((await db().prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_sub_%' ORDER BY name").all<{ name: string }>()).results.map(r => r.name)).toEqual(["idx_sub_proposer", "idx_sub_register", "idx_sub_state"]);
  });
  it("migration 0004 applies to a populated database, keeping every parent and child row", async () => {
    const id = (await create("itu-editor")).json.submission.id;
    await api("POST", `/api/me/submissions/${id}/submit`, { session: "itu-editor", body: {} });
    const count = async (t: string) => (await db().prepare(`SELECT count(*) n FROM ${t}`).first<{ n: number }>())!.n;
    const before = { s: await count("submissions"), r: await count("submission_revisions"), h: await count("review_state"), a: await count("audit_log") };
    expect(before.s).toBe(1);
    const migrations = (env as unknown as { TEST_MIGRATIONS: { name: string; queries: string[] }[] }).TEST_MIGRATIONS;
    const m = migrations.find(x => x.name.startsWith("0004"))!;
    await db().batch(m.queries.map(q => db().prepare(q)));
    expect({ s: await count("submissions"), r: await count("submission_revisions"), h: await count("review_state"), a: await count("audit_log") }).toEqual(before);
    expect((await db().prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    expect((await db().prepare("SELECT state FROM submissions WHERE id=?1").bind(id).first<{ state: string }>())!.state).toBe("submitted");
    expect((await db().prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_sub_%' ORDER BY name").all<{ name: string }>()).results.map(r => r.name)).toEqual(["idx_sub_proposer", "idx_sub_register", "idx_sub_state"]);
  });
});

describe("repository reader", () => {
  const empty = (flags: { file: boolean; dir?: boolean }, extra: Record<string, string> = {}) => new FakeRepoReader({ [`${REPO}:datasets.yaml`]: datasets(flags), ...extra });
  it("reports empty only when datasets.yaml lists the dataset without data and its changes/ is empty", async () => {
    expect(await registerIsEmpty(empty({ file: false }), REPO, "e118-iin")).toBe(true);
    expect(await registerIsEmpty(empty({ file: true }), REPO, "e118-iin")).toBe(false);
    expect(await registerIsEmpty(empty({ file: false, dir: true }), REPO, "e118-iin")).toBe(false);
    expect(await registerIsEmpty(empty({ file: false }, { [`${REPO}:datasets/1161-E.118/changes/0001-ADD.yaml`]: "x" }), REPO, "e118-iin")).toBe(false);
  });
  it("fails closed on a missing, malformed or unreadable answer instead of reading it as empty", async () => {
    // The old default read snapshots/<slug>/current.json from itu-ob-data, which 404s everywhere: a 404 meant "empty".
    await expect(registerIsEmpty(new FakeRepoReader(), REPO, "e118-iin")).rejects.toThrow(RepoReadFailed);
    await expect(registerIsEmpty(empty({ file: false }, { [`${REPO}:datasets.yaml`]: "datasets: nope" }), REPO, "e118-iin")).rejects.toThrow(RepoReadFailed);
    await expect(registerIsEmpty(empty({ file: false }, { [`${REPO}:datasets.yaml`]: "null" }), REPO, "e118-iin")).rejects.toThrow(RepoReadFailed);
    await expect(registerIsEmpty(empty({ file: false }, { [`${REPO}:datasets.yaml`]: "datasets:\n- directory: other\n" }), REPO, "e118-iin")).rejects.toThrow(RepoReadFailed);
    await expect(registerIsEmpty(empty({ file: false }, { [`${REPO}:datasets.yaml`]: "datasets:\n- directory: 1161-E.118\n  has_data_file: 'no'\n  has_data_directory: false\n" }), REPO, "e118-iin")).rejects.toThrow(RepoReadFailed);
    await expect(registerIsEmpty(empty({ file: false }), REPO, "unknown-slug")).rejects.toThrow(RepoReadFailed);
    await expect(registerIsEmpty(empty({ file: false }), REPO, "e212-icc")).rejects.toThrow(RepoReadFailed); // catalog names no dataset directory
  });
  it("a real-shaped 404 on every path does not make a populated register empty", async () => {
    const reader = new GitHubContentsReader("t", async () => new Response('{"message":"Not Found"}', { status: 404 }));
    await expect(registerIsEmpty(reader, REPO, "e118-iin")).rejects.toThrow(RepoReadFailed);
  });
  it("GitHub reader lists a directory, maps 404 to null, and rejects odd shapes", async () => {
    const body = { value: JSON.stringify([{ name: "a.yaml" }, { name: "b.yaml" }]), status: 200 };
    const seen: string[] = [];
    const reader = new GitHubContentsReader("t", async (_u, init) => { seen.push((init.headers as Record<string, string>).Accept!); return new Response(body.value, { status: body.status }); });
    expect(await reader.list("o/r", "datasets/x/changes")).toEqual(["a.yaml", "b.yaml"]);
    expect(seen).toEqual(["application/vnd.github+json"]);
    body.status = 404; expect(await reader.list("o/r", "datasets/x/changes")).toBeNull();
    body.status = 200; body.value = '{"name":"a file"}'; await expect(reader.list("o/r", "x")).rejects.toThrow(RepoReadFailed);
    body.value = "null"; await expect(reader.list("o/r", "x")).rejects.toThrow(RepoReadFailed);
    body.value = "[1]"; await expect(reader.list("o/r", "x")).rejects.toThrow(RepoReadFailed);
  });
  it("refuses dot-segment repositories", async () => {
    let called = false;
    const reader = new GitHubContentsReader("t", async () => { called = true; return new Response("x"); });
    for (const repo of ["../..", "./.", "o/..", "../r", "o/r/x", "a b/c"]) {
      await expect(reader.read(repo, "a.yaml")).rejects.toThrow(RepoReadFailed);
      await expect(reader.list(repo, "a")).rejects.toThrow(RepoReadFailed);
    }
    expect(called).toBe(false);
  });
  it("without a token the configured reader refuses", () => {
    setRepoReader(null);
    expect(() => getRepoReader({})).toThrow(RepoReaderNotConfigured);
    expect(getRepoReader({ GITHUB_READ_TOKEN: "t" })).toBeInstanceOf(GitHubContentsReader);
  });
  it("GitHub reader sends a bearer token, maps 404 to null, and refuses odd paths and failures", async () => {
    const seen: { url: string; auth: string }[] = [];
    const status = { value: 200 };
    const reader = new GitHubContentsReader("tok", async (url, init) => { seen.push({ url, auth: (init.headers as Record<string, string>).Authorization! }); return new Response(status.value === 200 ? "body" : "", { status: status.value }); });
    expect(await reader.read("o/r", "ob-issues/1/a b.yaml", "abc")).toBe("body");
    expect(seen[0]).toEqual({ url: "https://api.github.com/repos/o/r/contents/ob-issues/1/a%20b.yaml?ref=abc", auth: "Bearer tok" });
    status.value = 404; expect(await reader.read("o/r", "x.yaml")).toBeNull();
    status.value = 500; await expect(reader.read("o/r", "x.yaml")).rejects.toThrow(RepoReadFailed);
    await expect(reader.read("o/r", "../secret")).rejects.toThrow(RepoReadFailed);
    await expect(reader.read("bad repo", "x")).rejects.toThrow(RepoReadFailed);
  });
});

describe("existing general message import route", () => {
  const path = "ob-issues/1331/misc_communications/001.yaml";
  const call = () => api("POST", "/api/admin/general-messages/import", { access: "itu-editor@example.test", body: { ob_issue_no: 1331, path } });
  it("fails closed without a reader and opens a draft with one", async () => {
    setRepoReader(null);
    expect((await call()).status).toBe(503);
    setRepoReader(new FakeRepoReader({ [`ituob/service-publications-docs:${path}`]: "type: misc_communications\nob_issue_no: '1331'\ntext: Old\n" }));
    const r = await call();
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.draft.path).toBe(path);
  });
});
