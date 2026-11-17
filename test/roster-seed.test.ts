import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN, Forbidden, addUser, api, db, submit } from "./helpers.ts";

interface Country { id: string; name: string; register_key: string }
const seed = (env as unknown as { TEST_ROSTER_SEED: {
  generatedSql: string; repeatedSql: string; committedSql: string;
  records: Country[]; sourceCountries: Country[];
} }).TEST_ROSTER_SEED;
const applySeed = async () => {
  // The committed artifact has one complete statement per non-comment line.
  for (const line of seed.committedSql.split("\n")) {
    if (line.trim() && !line.trimStart().startsWith("--")) await db().prepare(line).run();
  }
};
const members = async () => (await db().prepare("SELECT * FROM members ORDER BY id").all()).results;
const count = async (table: string) => (await db().prepare(`SELECT count(*) n FROM ${table}`).first<{ n: number }>())!.n;
const [own, other] = seed.records;

beforeEach(applySeed);

describe("checked-in roster seed on real D1", () => {
  it("is deterministic and includes every independently read source country", async () => {
    expect(seed.generatedSql).toBe(seed.committedSql);
    expect(seed.repeatedSql).toBe(seed.committedSql);
    expect(seed.sourceCountries.length).toBeGreaterThan(1);
    expect(seed.records.map(({ id, name, register_key }) => ({ id, name, register_key }))).toEqual(seed.sourceCountries);
    const rows = await members();
    expect(rows.map(({ id, name, register_key }) => ({ id, name, register_key }))).toEqual(seed.sourceCountries);
    expect(new Set(rows.map((r) => r.status))).toEqual(new Set(["suspended"]));
    for (const row of rows) {
      expect(row.created_at).toEqual(expect.any(String));
      expect(row.updated_at).toBe(row.created_at);
    }
    for (const table of ["users", "memberships", "user_roles", "membership_events"]) expect(await count(table), table).toBe(0);
  });

  it("applying the actual SQL twice preserves every row and timestamp", async () => {
    const first = await members();
    await applySeed();
    expect(await members()).toEqual(first);
    for (const table of ["users", "memberships", "user_roles", "membership_events"]) expect(await count(table), table).toBe(0);
  });

  it("preserves reviewed member changes, existing accounts, and affiliation history", async () => {
    await addUser("existing-user");
    expect((await api("POST", `/api/admin/members/${own.id}/status`, { access: ADMIN, body: { status: "active" } })).status).toBe(200);
    await db().prepare("UPDATE members SET name='Reviewed display name', updated_at='reviewed-timestamp' WHERE id=?1").bind(own.id).run();
    await db().prepare("INSERT INTO members (id,name,register_key,status,created_at,updated_at) VALUES ('local-reviewed','Local reviewed','Local reviewed','withdrawn','created','updated')").run();
    const beforeMembers = await members();
    const beforeUsers = (await db().prepare("SELECT * FROM users ORDER BY id").all()).results;
    const beforeEvents = (await db().prepare("SELECT * FROM membership_events ORDER BY id").all()).results;
    await applySeed();
    expect(await members()).toEqual(beforeMembers);
    expect((await db().prepare("SELECT * FROM users ORDER BY id").all()).results).toEqual(beforeUsers);
    expect((await db().prepare("SELECT * FROM membership_events ORDER BY id").all()).results).toEqual(beforeEvents);
    expect(await count("memberships")).toBe(0);
    expect(await count("user_roles")).toBe(0);
  });

  it("retains database role/kind, foreign-key, status, and one-live-membership constraints", async () => {
    await addUser("constraint-user");
    for (const sql of [
      "INSERT INTO user_roles (user_id,role,granted_at) VALUES ('constraint-user','owner','t')",
      "INSERT INTO user_roles (user_id,role,granted_at) VALUES ('missing-user','itu-admin','t')",
      "INSERT INTO memberships (user_id,kind,status,created_at) VALUES ('constraint-user','invalid','active','t')",
      "INSERT INTO memberships (user_id,kind,status,created_at) VALUES ('constraint-user','member','active','t')",
      "INSERT INTO memberships (user_id,kind,status,created_at) VALUES ('constraint-user','itu','invalid','t')",
    ]) await expect(db().prepare(sql).run(), sql).rejects.toThrow();
    await expect(db().prepare("INSERT INTO memberships (user_id,kind,member_id,status,created_at) VALUES ('constraint-user','itu',?1,'active','t')").bind(own.id).run()).rejects.toThrow();
    await db().prepare("INSERT INTO memberships (user_id,kind,member_id,status,created_at) VALUES ('constraint-user','member',?1,'pending','t')").bind(own.id).run();
    await expect(db().prepare("INSERT INTO memberships (user_id,kind,member_id,status,created_at) VALUES ('constraint-user','member',?1,'active','t')").bind(other.id).run()).rejects.toThrow(/UNIQUE/);
    expect(await count("memberships")).toBe(1);
    expect(await count("user_roles")).toBe(0);
  });

  it("requires activation and Access verification, isolates countries, and preserves history after deactivation", async () => {
    await addUser("seed-claimant");
    const claim = () => api("POST", "/api/me/membership/claim", { session: "seed-claimant", body: { memberId: own.id } });
    expect((await claim()).status).toBe(400);
    expect(await count("memberships")).toBe(0);
    for (const member of [own, other]) expect((await api("POST", `/api/admin/members/${member.id}/status`, { access: ADMIN, body: { status: "active" } })).status).toBe(200);
    const c = await claim();
    expect(c.status).toBe(201);
    const membershipId = c.json.membershipId;
    expect((await api("GET", "/api/whoami", { session: "seed-claimant" })).json).toMatchObject({ roles: [], memberStateId: null });
    await expect(submit("seed-claimant", [own.register_key])).rejects.toBeInstanceOf(Forbidden);
    expect((await api("POST", `/api/admin/claims/${membershipId}/verify`, { session: "seed-claimant", body: {} })).status).toBe(403);
    expect((await db().prepare("SELECT status FROM memberships WHERE id=?1").bind(membershipId).first<{ status: string }>())!.status).toBe("pending");
    expect(await count("user_roles")).toBe(0);
    expect((await api("POST", `/api/admin/claims/${membershipId}/verify`, { access: ADMIN, body: {} })).status).toBe(200);
    expect((await api("GET", "/api/whoami", { session: "seed-claimant" })).json).toMatchObject({ roles: ["member-submitter"], memberStateId: own.id });
    expect(await submit("seed-claimant", [own.register_key])).toBe(1);
    const history = (await db().prepare("SELECT * FROM test_submissions ORDER BY id").all()).results;
    await expect(submit("seed-claimant", [other.register_key])).rejects.toBeInstanceOf(Forbidden);
    expect((await db().prepare("SELECT * FROM test_submissions ORDER BY id").all()).results).toEqual(history);
    expect((await api("POST", `/api/admin/memberships/${membershipId}/deactivate`, { access: ADMIN, body: { note: "contact left" } })).status).toBe(200);
    const affiliation = (await db().prepare("SELECT * FROM memberships ORDER BY id").all()).results;
    const roles = (await db().prepare("SELECT * FROM user_roles ORDER BY user_id,role").all()).results;
    const events = (await db().prepare("SELECT * FROM membership_events ORDER BY id").all()).results;
    await applySeed();
    await expect(submit("seed-claimant", [own.register_key])).rejects.toBeInstanceOf(Forbidden);
    expect((await api("GET", "/api/whoami", { session: "seed-claimant" })).json).toMatchObject({ roles: [], memberStateId: null });
    expect((await db().prepare("SELECT * FROM test_submissions ORDER BY id").all()).results).toEqual(history);
    expect((await db().prepare("SELECT * FROM memberships ORDER BY id").all()).results).toEqual(affiliation);
    expect((await db().prepare("SELECT * FROM user_roles ORDER BY user_id,role").all()).results).toEqual(roles);
    expect((await db().prepare("SELECT * FROM membership_events ORDER BY id").all()).results).toEqual(events);
    expect(events.filter((e) => e.membership_id === membershipId).map((e) => e.event)).toEqual(["claimed", "verified", "deactivated"]);
  });
});
