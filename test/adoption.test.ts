import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { parseApprovers } from "../worker/lib/adoption.ts";
import { verifyChain } from "../worker/lib/audit.ts";
import { handleApi } from "../worker/routes.ts";
import { isAdopted } from "../src/lib/adoption.ts";
import { activateMember, addUser, api, db, provisionItu, seedMembers } from "./helpers.ts";

const SHA1 = "a".repeat(64);
const SHA2 = "b".repeat(64);
const file = (sha256 = SHA1) => ({ standard: "T-SP-PP.RES.21-2011", edition_year: 2011, language: "en", sha256 });
const EDITOR = "itu-editor@example.test";

beforeEach(async () => {
  await seedMembers();
  for (const u of ["itu-editor", "itu-admin", "member-A"]) await addUser(u);
  await provisionItu("itu-editor", ["itu-editor"]);
  await provisionItu("itu-admin", ["itu-admin"]);
  await activateMember("member-A", "A");
});

const adoptions = async () => (await api("GET", "/api/publications/adoptions")).json.adoptions as any[];

describe("PDF adoption", () => {
  it("shows candidate by default: nothing is adopted", async () => {
    expect(await adoptions()).toEqual([]);
    expect(isAdopted(file(), await adoptions())).toBe(false);
  });

  it("refuses a member (session or Access email) and anonymous callers with 403, writing nothing", async () => {
    const asSession = await api("POST", "/api/admin/publications/adopt", { session: "member-A", body: file() });
    const asAccess = await api("POST", "/api/admin/publications/adopt", { access: "member-A@example.test", body: file() });
    const anon = await api("POST", "/api/admin/publications/adopt", { body: file() });
    const unknown = await api("POST", "/api/admin/publications/adopt", { access: "nobody@example.test", body: file() });
    expect([asSession.status, asAccess.status, anon.status, unknown.status]).toEqual([403, 403, 403, 403]);
    expect(await adoptions()).toEqual([]);
    expect((await db().prepare("SELECT count(*) n FROM audit_log WHERE action LIKE 'publication.%'").first<any>()).n).toBe(0);
  });

  it("ITU staff adopt; the record, the audit row and the public list agree", async () => {
    const r = await api("POST", "/api/admin/publications/adopt", { access: EDITOR, body: file() });
    expect(r.status).toBe(201);
    const list = await adoptions();
    expect(list).toHaveLength(1);
    expect(isAdopted(file(), list)).toBe(true);
    const audit = await db().prepare("SELECT * FROM audit_log WHERE action='publication.adopted'").all<any>();
    expect(audit.results).toHaveLength(1);
    const row = audit.results[0]!;
    expect(row.actor_id).toBe("itu-editor");
    expect(row.subject_type).toBe("publication");
    expect(JSON.parse(row.detail)).toMatchObject({ ...file(), by: "itu-editor" });
    expect(await verifyChain(db())).toBeNull();
    const rec = await db().prepare("SELECT adopted_by, adopted_at FROM publication_adoptions").first<any>();
    expect(rec.adopted_by).toBe("itu-editor");
    expect(rec.adopted_at).toBe(row.at);
  });

  it("a sha256 mismatch (a re-render) is not adopted", async () => {
    await api("POST", "/api/admin/publications/adopt", { access: EDITOR, body: file(SHA1) });
    expect(isAdopted(file(SHA2), await adoptions())).toBe(false);
    expect(isAdopted({ ...file(SHA1), language: "fr" }, await adoptions())).toBe(false);
    expect(isAdopted({ ...file(SHA1), edition_year: 2012 }, await adoptions())).toBe(false);
  });

  it("rejects a malformed body and a duplicate adoption", async () => {
    expect((await api("POST", "/api/admin/publications/adopt", { access: EDITOR, body: { ...file(), sha256: "abc" } })).status).toBe(400);
    expect((await api("POST", "/api/admin/publications/adopt", { access: EDITOR, body: { ...file(), edition_year: "2011" } })).status).toBe(400);
    expect((await api("POST", "/api/admin/publications/adopt", { access: EDITOR, body: file() })).status).toBe(201);
    expect((await api("POST", "/api/admin/publications/adopt", { access: EDITOR, body: file() })).status).toBe(409);
    expect((await db().prepare("SELECT count(*) n FROM audit_log WHERE action='publication.adopted'").first<any>()).n).toBe(1);
  });

  it("revocation returns the file to candidate, is audited, and may be re-adopted", async () => {
    await api("POST", "/api/admin/publications/adopt", { access: EDITOR, body: file() });
    expect((await api("POST", "/api/admin/publications/revoke", { session: "member-A", body: file() })).status).toBe(403);
    expect((await api("POST", "/api/admin/publications/revoke", { access: "member-A@example.test", body: file() })).status).toBe(403);
    expect(await adoptions()).toHaveLength(1);
    expect((await api("POST", "/api/admin/publications/revoke", { access: "itu-admin@example.test", body: file() })).status).toBe(200);
    expect(await adoptions()).toEqual([]);
    expect((await api("POST", "/api/admin/publications/revoke", { access: EDITOR, body: file() })).status).toBe(404);
    const audit = await db().prepare("SELECT actor_id, action FROM audit_log WHERE action LIKE 'publication.%' ORDER BY id").all<any>();
    expect(audit.results.map((r) => [r.action, r.actor_id])).toEqual([["publication.adopted", "itu-editor"], ["publication.adoption_revoked", "itu-admin"]]);
    expect(await verifyChain(db())).toBeNull();
    expect((await api("POST", "/api/admin/publications/adopt", { access: EDITOR, body: file() })).status).toBe(201);
    expect(await adoptions()).toHaveLength(1);
  });
});

describe("ADOPTION_APPROVERS (owner-set config)", () => {
  const call = (approvers: string | undefined, access: string) =>
    handleApi(
      new Request("http://localhost/api/admin/publications/adopt", {
        method: "POST",
        headers: { "X-Stub-Access": access, "Content-Type": "application/json" },
        body: JSON.stringify(file()),
      }),
      { ...env, ADOPTION_APPROVERS: approvers } as any,
      new URL("http://localhost/api/admin/publications/adopt"),
    );

  it("defaults to ITU staff roles", () => {
    expect([...parseApprovers(undefined).roles].sort()).toEqual(["itu-admin", "itu-editor"]);
    expect(parseApprovers("  ").emails.size).toBe(0);
  });
  it("an email allowlist can name an approver; roles not listed no longer qualify", async () => {
    await addUser("owner-pick");
    await provisionItu("owner-pick", ["itu-editor"]);
    expect((await call("email:Owner-Pick@example.test", EDITOR)).status).toBe(403);
    expect((await call("email:owner-pick@example.test", "owner-pick@example.test")).status).toBe(201);
  });
  it("a malformed value fails closed", async () => {
    expect(parseApprovers("role:itu-editor,bogus").roles.size).toBe(0);
    expect(parseApprovers("role:nope").roles.size).toBe(0);
    expect((await call("role:itu-editor;", EDITOR)).status).toBe(403);
  });
});
