import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakePatchPublisher, setPublisher } from "../worker/lib/publisher.ts";
import { FakeRepoReader, GitHubContentsReader, RepoReadFailed, RepoReaderNotConfigured, getRepoReader, registerIsEmpty, setRepoReader } from "../worker/lib/repo-reader.ts";
import { activateMember, api, db, provisionItu, seedFixtures } from "./helpers.ts";

const entry = (n: string) => ({ country_or_area: { en: "Aland" }, company_name: `Acme ${n}`, issue_id_number: `89 358 ${n}` });
const seed = (entries = [entry("01"), entry("02")]) => ({ register_id: "E118_IIN", slug: "e118-iin", action_type: "SEED", payload: { type: "SEED", data: { _class: "E118Amendment", entries } } });
const snapshot = (n: number) => JSON.stringify({ entry_count: n, active_entries: [] });
const SNAP = "ituob/itu-ob-data:snapshots/e118-iin/current.json";
let reader: FakeRepoReader;
beforeEach(async () => {
  await seedFixtures();
  await activateMember("member-A", "A");
  await provisionItu("itu-editor", ["itu-editor"]);
  await provisionItu("itu-admin", ["itu-admin"]);
  setPublisher(new FakePatchPublisher());
  reader = new FakeRepoReader({ [SNAP]: snapshot(0) });
  setRepoReader(reader);
});
afterEach(() => { setPublisher(null); setRepoReader(null); });
const create = (who: string, b: unknown = seed()) => api("POST", "/api/me/submissions", { session: who, body: b });

describe("staff-only SEED", () => {
  it("is stored for ITU staff on an empty register, with its schema-validated full payload", async () => {
    const r = await create("itu-editor");
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.submission.action_type).toBe("SEED");
    expect(reader.reads).toEqual([SNAP]);
  });
  it("is refused for a member session, before any repository read", async () => {
    expect((await create("member-A")).status).toBe(403);
    expect(reader.reads).toEqual([]);
  });
  it("is refused with a conflict when the register already has state", async () => {
    reader.set("ituob/itu-ob-data", "snapshots/e118-iin/current.json", snapshot(3));
    const r = await create("itu-editor");
    expect(r.status).toBe(409);
    expect((await db().prepare("SELECT count(*) n FROM submissions").first<{ n: number }>())!.n).toBe(0);
  });
  it("fails closed when the repository cannot be read or is not configured", async () => {
    setRepoReader(null);
    expect((await create("itu-editor")).status).toBe(503);
    setRepoReader({ read: async () => { throw new RepoReadFailed("GitHub read failed (500)"); } });
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
    reader.set("ituob/itu-ob-data", "snapshots/e118-iin/current.json", snapshot(2));
    const r = await api("POST", `/api/admin/submissions/${id}/approve`, { access: "itu-admin@example.test", body: { target_edition: 1400 } });
    expect(r.status).toBe(409);
  });
  it("the rebuilt table keeps child rows and foreign keys intact", async () => {
    const id = (await create("itu-editor")).json.submission.id;
    expect((await db().prepare("SELECT count(*) n FROM submission_revisions WHERE submission_id=?1").bind(id).first<{ n: number }>())!.n).toBe(1);
    expect((await db().prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    expect((await db().prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_sub_%' ORDER BY name").all<{ name: string }>()).results.map(r => r.name)).toEqual(["idx_sub_proposer", "idx_sub_register", "idx_sub_state"]);
  });
});

describe("repository reader", () => {
  it("treats a missing snapshot as empty and a malformed one as a failure", async () => {
    expect(await registerIsEmpty(new FakeRepoReader(), "o/r", "x")).toBe(true);
    await expect(registerIsEmpty(new FakeRepoReader({ "o/r:snapshots/x/current.json": "{" }), "o/r", "x")).rejects.toThrow(RepoReadFailed);
    await expect(registerIsEmpty(new FakeRepoReader({ "o/r:snapshots/x/current.json": "{}" }), "o/r", "x")).rejects.toThrow(RepoReadFailed);
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
