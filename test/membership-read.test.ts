import { beforeEach, describe, expect, it } from "vitest";
import { activateMember, api, db, seedFixtures } from "./helpers.ts";

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
