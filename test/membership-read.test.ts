import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN, activateMember, api, db, seedFixtures } from "./helpers.ts";

beforeEach(async () => {
  await seedFixtures();
  await activateMember("member-A", "A");
  await activateMember("member-B", "B");
});

describe("membership screen read contracts", () => {
  it("returns only active public roster names without account or register metadata", async () => {
    await db().prepare("UPDATE members SET status='suspended' WHERE id='B'").run();
    const response = await api("GET", "/api/members");
    expect(response.status).toBe(200);
    expect(response.json.members).toEqual([{ id: "A", name: "Aland (Republic)", status: "active" }]);
  });

  it("requires a member session and returns only that account's claims", async () => {
    expect((await api("GET", "/api/me/membership")).status).toBe(401);
    const response = await api("GET", "/api/me/membership", { session: "member-A", headers: { "Sec-Fetch-Site": "same-origin" } });
    expect(response.status).toBe(200);
    expect(response.json.memberships).toHaveLength(1);
    expect(response.json.memberships[0]).toMatchObject({ kind: "member", member_id: "A", status: "active" });
    expect(response.json.memberships.some((m: { member_id: string }) => m.member_id === "B")).toBe(false);
  });

  it("keeps administrative claim reads behind the D1 admin role even with an Access identity", async () => {
    for (const access of ["member-A@example.test", "unaffiliated@example.test", "unknown@example.test"]) {
      const response = await api("GET", "/api/admin/claims?status=active", { access });
      expect(response.status).toBe(403);
      expect(response.json).not.toHaveProperty("claims");
    }
    const response = await api("GET", "/api/admin/claims?status=active", { access: ADMIN });
    expect(response.status).toBe(200);
    expect(response.json.claims.map((c: { user_id: string }) => c.user_id).sort()).toEqual(["member-A", "member-B"]);
  });

  it("reports Access separately without promoting it to a member session", async () => {
    const response = await api("GET", "/api/whoami", { access: "editor@example.test" });
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ authenticated: false, access: { email: "editor@example.test" } });
  });

  it("reads only the current account's saved notification preference and handle", async () => {
    expect((await api("GET", "/api/me/notification-prefs")).status).toBe(401);
    const own = { session: "member-A", headers: { "Sec-Fetch-Site": "same-origin" } };
    expect((await api("GET", "/api/me/notification-prefs", own)).json.level).toBe("all");
    expect((await api("PUT", "/api/me/notification-prefs", { ...own, body: { level: "none" } })).status).toBe(200);
    expect((await api("PUT", "/api/me/handle", { ...own, body: { handle: "member-a" } })).status).toBe(200);
    expect((await api("GET", "/api/me/notification-prefs", own)).json.level).toBe("none");
    expect((await api("GET", "/api/me/handle", own)).json.handle).toBe("member-a");
    const other = { session: "member-B", headers: { "Sec-Fetch-Site": "same-origin" } };
    expect((await api("GET", "/api/me/notification-prefs", other)).json.level).toBe("all");
    expect((await api("GET", "/api/me/handle", other)).json.handle).toBeNull();
  });
});
