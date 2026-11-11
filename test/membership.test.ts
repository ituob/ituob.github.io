import { describe, expect, it, beforeEach } from "vitest";
import {
  ADMIN, Forbidden, activateMember, addUser, api, db, provisionItu, seedFixtures, submit,
} from "./helpers.ts";

const count = async (sql: string, ...b: unknown[]) =>
  (await db().prepare(sql).bind(...b).first<{ n: number }>())!.n;

beforeEach(seedFixtures);

describe("cross-country denial", () => {
  it("member of A cannot submit for B; mixed and unresolvable payloads write nothing", async () => {
    await activateMember("member-A", "A");
    await expect(submit("member-A", ["Bland"])).rejects.toBeInstanceOf(Forbidden);
    await expect(submit("member-A", ["Aland", "Bland"])).rejects.toBeInstanceOf(Forbidden);
    await expect(submit("member-A", ["Nowhere"])).rejects.toBeInstanceOf(Forbidden);
    expect(await count("SELECT count(*) n FROM test_submissions")).toBe(0);
    expect(await submit("member-A", ["Aland"])).toBe(1);
    expect(await count("SELECT count(*) n FROM test_submissions")).toBe(1);
  });

  it("member-B is bound to B and cannot act for A", async () => {
    await activateMember("member-A", "A");
    await activateMember("member-B", "B");
    await expect(submit("member-B", ["Aland"])).rejects.toBeInstanceOf(Forbidden);
    expect(await submit("member-B", ["Bland"])).toBe(1);
  });

  it("an ITU editor may submit for any key, including non-ITU areas; unaffiliated cannot", async () => {
    await provisionItu("itu-editor", ["itu-editor"]);
    expect(await submit("itu-editor", ["Aland", "Bland", "Non-ITU area"])).toBe(3);
    await expect(submit("unaffiliated", ["Aland"])).rejects.toBeInstanceOf(Forbidden);
  });
});

describe("spoofed binding is ignored", () => {
  it("claim body status/roles/userId/member cannot change the outcome", async () => {
    const r = await api("POST", "/api/me/membership/claim", {
      session: "unaffiliated",
      body: { memberId: "A", note: "x", status: "active", roles: ["itu-admin"], userId: "itu-admin", kind: "itu", memberStateId: "B" },
    });
    expect(r.status).toBe(201);
    const m = await db().prepare("SELECT user_id,kind,member_id,status FROM memberships").first<any>();
    expect(m).toEqual({ user_id: "unaffiliated", kind: "member", member_id: "A", status: "pending" });
    expect(await count("SELECT count(*) n FROM user_roles")).toBe(0);
    const w = await api("GET", "/api/whoami", { session: "unaffiliated" });
    expect(w.json.roles).toEqual([]);
    expect(w.json.memberStateId).toBeNull();
  });
});

describe("deactivation blocks new actions but preserves history", () => {
  it("deactivated-member-A", async () => {
    const mid = await activateMember("deactivated-member-A", "A");
    await submit("deactivated-member-A", ["Aland"]);
    const before = await db().prepare("SELECT * FROM test_submissions").all();
    const d = await api("POST", `/api/admin/memberships/${mid}/deactivate`, { access: ADMIN, body: { note: "left administration" } });
    expect(d.status).toBe(200);
    const w = await api("GET", "/api/whoami", { session: "deactivated-member-A" });
    expect(w.json).toMatchObject({ authenticated: true, roles: [], memberStateId: null });
    await expect(submit("deactivated-member-A", ["Aland"])).rejects.toBeInstanceOf(Forbidden);
    expect((await db().prepare("SELECT * FROM test_submissions").all()).results).toEqual(before.results);
    const mem = await db().prepare("SELECT status,member_id FROM memberships WHERE id=?1").bind(mid).first<any>();
    expect(mem).toEqual({ status: "deactivated", member_id: "A" });
    const evs = (await db().prepare("SELECT event FROM membership_events WHERE membership_id=?1 ORDER BY id").bind(mid).all<{ event: string }>()).results.map((e) => e.event);
    expect(evs).toEqual(["claimed", "verified", "deactivated"]);
    // a role row left behind is inert, and the user cannot claim to bypass: re-claim is a new pending row
    expect(await count("SELECT count(*) n FROM user_roles WHERE user_id='deactivated-member-A'")).toBe(1);
  });
});

describe("survives member-state status changes", () => {
  it("suspended / withdrawn / active again: record intact, authority follows state", async () => {
    await activateMember("member-A", "A");
    await submit("member-A", ["Aland"]);
    const snap = async () => (await db().prepare("SELECT * FROM test_submissions").all()).results;
    const original = await snap();
    for (const s of ["suspended", "withdrawn"]) {
      const r = await api("POST", "/api/admin/members/A/status", { access: ADMIN, body: { status: s } });
      expect(r.status).toBe(200);
      expect(await snap()).toEqual(original);
      expect((await api("GET", "/api/whoami", { session: "member-A" })).json.roles).toEqual([]);
      await expect(submit("member-A", ["Aland"])).rejects.toBeInstanceOf(Forbidden);
    }
    await api("POST", "/api/admin/members/A/status", { access: ADMIN, body: { status: "active" } });
    expect(await snap()).toEqual(original);
    expect((await api("GET", "/api/whoami", { session: "member-A" })).json).toMatchObject({ roles: ["member-submitter"], memberStateId: "A" });
    expect(await submit("member-A", ["Aland"])).toBe(1);
    // the stored record has no FK onto memberships.status: deleting is unsupported (RESTRICT)
    await expect(db().prepare("DELETE FROM members WHERE id='A'").run()).rejects.toThrow();
  });
});

describe("no self-activation", () => {
  it("pending yields roles [] and no member-facing endpoint can activate", async () => {
    const c = await api("POST", "/api/me/membership/claim", { session: "member-A", body: { memberId: "A" } });
    expect(c.status).toBe(201);
    expect((await api("GET", "/api/whoami", { session: "member-A" })).json.roles).toEqual([]);
    for (const p of [`/api/admin/claims/${c.json.membershipId}/verify`, `/api/admin/itu-staff`, `/api/admin/members/A/status`, `/api/admin/roster/import`]) {
      const r = await api("POST", p, { session: "member-A", body: { userId: "member-A", roles: ["itu-admin"], status: "active", members: [] } });
      expect(r.status).toBe(403);
    }
    const m = await db().prepare("SELECT status FROM memberships").first<any>();
    expect(m.status).toBe("pending");
    expect(await count("SELECT count(*) n FROM user_roles")).toBe(0);
  });

  it("a second live membership is refused (API and unique index)", async () => {
    await api("POST", "/api/me/membership/claim", { session: "member-A", body: { memberId: "A" } });
    const r = await api("POST", "/api/me/membership/claim", { session: "member-A", body: { memberId: "B" } });
    expect(r.status).toBe(409);
    await expect(
      db().prepare("INSERT INTO memberships (user_id,kind,member_id,status,created_at) VALUES ('member-A','member','B','active','t')").run(),
    ).rejects.toThrow(/UNIQUE/);
  });

  it("claims need a session and a same-origin request", async () => {
    expect((await api("POST", "/api/me/membership/claim", { body: { memberId: "A" } })).status).toBe(401);
    expect((await api("POST", "/api/me/membership/claim", { session: "member-A", body: { memberId: "A" }, headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
    expect(await count("SELECT count(*) n FROM memberships")).toBe(0);
  });

  it("rejected claimant can re-claim", async () => {
    const c = await api("POST", "/api/me/membership/claim", { session: "member-A", body: { memberId: "A" } });
    expect((await api("POST", `/api/admin/claims/${c.json.membershipId}/reject`, { access: ADMIN, body: { note: "no" } })).status).toBe(200);
    expect((await api("POST", "/api/me/membership/claim", { session: "member-A", body: { memberId: "A" } })).status).toBe(201);
  });
});

describe("role/kind coherence", () => {
  it("role rows without a matching active membership are inert", async () => {
    const t = "2026-01-01T00:00:00Z";
    await db().prepare("INSERT INTO user_roles (user_id,role,granted_at) VALUES ('itu-editor','itu-editor',?1),('member-A','member-submitter',?1),('member-B','itu-admin',?1)").bind(t).run();
    for (const u of ["itu-editor", "member-A", "member-B"]) {
      expect((await api("GET", "/api/whoami", { session: u })).json).toMatchObject({ roles: [], memberStateId: null });
    }
    // a member-kind membership cannot carry ITU roles; an itu membership cannot carry member-submitter
    await db().prepare("INSERT INTO memberships (user_id,kind,member_id,status,created_at) VALUES ('member-B','member','B','active',?1)").bind(t).run();
    expect((await api("GET", "/api/whoami", { session: "member-B" })).json.roles).toEqual([]);
    await db().prepare("INSERT INTO memberships (user_id,kind,status,created_at) VALUES ('itu-editor','itu','active',?1)").bind(t).run();
    expect((await api("GET", "/api/whoami", { session: "itu-editor" })).json.roles).toEqual(["itu-editor"]);
    await db().prepare("INSERT INTO user_roles (user_id,role,granted_at) VALUES ('itu-editor','member-submitter',?1)").bind(t).run();
    expect((await api("GET", "/api/whoami", { session: "itu-editor" })).json.roles).toEqual(["itu-editor"]);
  });

  it("kind/member_id CHECK is enforced by the schema", async () => {
    await expect(db().prepare("INSERT INTO memberships (user_id,kind,member_id,status,created_at) VALUES ('itu-admin','itu','A','active','t')").run()).rejects.toThrow();
    await expect(db().prepare("INSERT INTO memberships (user_id,kind,status,created_at) VALUES ('itu-admin','member','active','t')").run()).rejects.toThrow();
  });
});

describe("ITU-only actions", () => {
  const admin = [
    ["POST", "/api/admin/claims/1/verify"], ["POST", "/api/admin/claims/1/reject"],
    ["POST", "/api/admin/memberships/1/deactivate"], ["POST", "/api/admin/itu-staff"],
    ["POST", "/api/admin/roster/import"], ["POST", "/api/admin/members/A/status"], ["GET", "/api/admin/claims"],
    ["POST", "/api/admin/anything-else"], ["GET", "/api/admin/anything-else"], ["POST", "/api/ci/x"],
  ] as const;
  it("member-submitter, itu-admin session and anonymous are all 403 without Access", async () => {
    await activateMember("member-A", "A");
    await provisionItu("itu-admin", ["itu-admin"]);
    for (const [m, p] of admin) {
      for (const session of ["member-A", "itu-admin", undefined]) {
        const r = await api(m, p, { session, body: {} });
        expect(r.status, `${m} ${p} as ${session}`).toBe(403);
      }
    }
  });
  it("Access alone (no session) is enough for admin routes", async () => {
    expect((await api("GET", "/api/admin/claims", { access: ADMIN })).status).toBe(200);
  });
  it("Access does not satisfy session routes", async () => {
    expect((await api("POST", "/api/me/membership/claim", { access: ADMIN, body: { memberId: "A" } })).status).toBe(401);
  });
});

describe("deny by default", () => {
  it("every non-GET /api/* that is not a declared route is 403; GET stays 404", async () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      for (const p of ["/api/anything", "/api/me/other", "/api/health", "/api/whoami"]) {
        expect((await api(m, p, { session: "itu-admin", access: ADMIN, body: {} })).status, `${m} ${p}`).toBe(403);
      }
    }
    expect((await api("GET", "/api/nope")).status).toBe(404);
    expect((await api("GET", "/api/health")).json).toMatchObject({ ok: true, service: "ituob-org" });
  });
});

describe("roster", () => {
  const rows = [
    { id: "A", name: "Aland (Republic)", register_key: "Aland" },
    { id: "C", name: "Cland", register_key: "Cland" },
  ];
  it("re-import is idempotent; a missing member is reported, not deleted", async () => {
    const dry = await api("POST", "/api/admin/roster/import?dry_run=1", { access: ADMIN, body: { members: rows } });
    expect(dry.json).toMatchObject({ dry_run: true, added: ["C"], missing: ["B"] });
    expect(await count("SELECT count(*) n FROM members WHERE id='C'")).toBe(0);
    const one = await api("POST", "/api/admin/roster/import", { access: ADMIN, body: { members: rows } });
    expect(one.json).toMatchObject({ added: ["C"], missing: ["B"] });
    const two = await api("POST", "/api/admin/roster/import", { access: ADMIN, body: { members: rows } });
    expect(two.json).toMatchObject({ added: [], changed: [], missing: ["B"] });
    expect((await db().prepare("SELECT status FROM members WHERE id='B'").first<any>()).status).toBe("active");
    expect(await count("SELECT count(*) n FROM members")).toBe(3);
  });
  it("rejects malformed rows", async () => {
    expect((await api("POST", "/api/admin/roster/import", { access: ADMIN, body: { members: [{ id: "X" }] } })).status).toBe(400);
  });
  it("seed script emits idempotent SQL that applies to D1", async () => {
    // @ts-expect-error plain .mjs script
    const { parseCsv, toSql } = await import("../scripts/roster-to-sql.mjs");
    const sql = toSql(parseCsv('id,name,register_key,iso3166_alpha2,itu_identifier,member_since,status\nZ,"Zed, Land (O\'Neil)",Zedland,ZZ,,2001,active\n'), "2026-01-01T00:00:00Z");
    for (let i = 0; i < 2; i++) for (const stmt of sql.trim().split("\n")) await db().prepare(stmt).run();
    const z = await db().prepare("SELECT name,register_key FROM members WHERE id='Z'").first<any>();
    expect(z).toEqual({ name: "Zed, Land (O'Neil)", register_key: "Zedland" });
    expect(await count("SELECT count(*) n FROM members WHERE id='Z'")).toBe(1);
  });
});

describe("end to end (acceptance)", () => {
  it("claim -> verify -> submit own country -> deactivate -> fail; every user inert or exactly one live membership", async () => {
    await provisionItu("itu-admin", ["itu-admin"]);
    const mid = await activateMember("member-A", "A");
    expect(await submit("member-A", ["Aland"])).toBe(1);
    await api("POST", `/api/admin/memberships/${mid}/deactivate`, { access: ADMIN, body: {} });
    await expect(submit("member-A", ["Aland"])).rejects.toBeInstanceOf(Forbidden);
    await api("POST", "/api/me/membership/claim", { session: "member-B", body: { memberId: "B" } });

    const users = (await db().prepare("SELECT id FROM users").all<{ id: string }>()).results;
    expect(users.length).toBeGreaterThan(0);
    for (const u of users) {
      const live = await count("SELECT count(*) n FROM memberships WHERE user_id=?1 AND status IN ('pending','active')", u.id);
      expect(live).toBeLessThanOrEqual(1);
      const w = (await api("GET", "/api/whoami", { session: u.id })).json;
      const active = await count("SELECT count(*) n FROM memberships WHERE user_id=?1 AND status='active'", u.id);
      if (active === 0) expect(w).toMatchObject({ roles: [], memberStateId: null }); // unaffiliated/pending/deactivated: no authority
      else expect(w.roles.length > 0 && (w.memberStateId !== null) !== w.roles.some((r: string) => r.startsWith("itu-"))).toBe(true); // ITU xor one state
    }
  });

  it("claim cap per member state", async () => {
    for (let i = 0; i < 20; i++) { await addUser(`u${i}`); await api("POST", "/api/me/membership/claim", { session: `u${i}`, body: { memberId: "A" } }); }
    await addUser("u-extra");
    expect((await api("POST", "/api/me/membership/claim", { session: "u-extra", body: { memberId: "A" } })).status).toBe(409);
  });
});
