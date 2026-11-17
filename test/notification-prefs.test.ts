import { beforeEach, describe, expect, it } from "vitest";
import { api, seedFixtures } from "./helpers.ts";

describe("notification preferences", () => {
  beforeEach(async () => { await seedFixtures(); });

  it("returns defaults and persists delivery and locale while preserving level-only updates", async () => {
    const initial = await api("GET", "/api/me/notification-prefs", { session: "member-A", headers: { "Sec-Fetch-Site": "same-origin" } });
    expect(initial.status).toBe(200);
    expect(initial.json).toMatchObject({ ok: true, level: "all", delivery: "immediate", locale: null });

    const set = await api("PUT", "/api/me/notification-prefs", {
      session: "member-A", body: { level: "mentions", delivery: "digest", locale: "fr-CA" },
    });
    expect(set.status).toBe(200);
    expect(set.json).toMatchObject({ ok: true, level: "mentions", delivery: "digest", locale: "fr-CA" });

    const levelOnly = await api("PUT", "/api/me/notification-prefs", { session: "member-A", body: { level: "none" } });
    expect(levelOnly.json).toMatchObject({ level: "none", delivery: "digest", locale: "fr-CA" });
    const read = await api("GET", "/api/me/notification-prefs", { session: "member-A", headers: { "Sec-Fetch-Site": "same-origin" } });
    expect(read.json).toMatchObject({ level: "none", delivery: "digest", locale: "fr-CA" });
  });

  it("rejects invalid delivery, locale and unauthenticated access", async () => {
    expect((await api("PUT", "/api/me/notification-prefs", { session: "member-A", body: { level: "all", delivery: "weekly" } })).status).toBe(400);
    expect((await api("PUT", "/api/me/notification-prefs", { session: "member-A", body: { level: "all", locale: "bad locale" } })).status).toBe(400);
    expect((await api("GET", "/api/me/notification-prefs", { headers: { "Sec-Fetch-Site": "same-origin" } })).status).toBe(401);
  });
});
