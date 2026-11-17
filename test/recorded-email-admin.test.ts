import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN, api, bootstrapAdmin, db } from "./helpers.ts";

const ACCESS = ADMIN;

async function seedEmails() {
  for (const [id, to] of [["email-a", "a@example.test"], ["email-b", "b@example.test"], ["email-c", "c@example.test"]]) {
    await db().prepare(`INSERT INTO recorded_emails
      (id, to_address, subject, text_body, html_body, locale, recorded_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`)
      .bind(id, to, `Subject ${id}`, `Text ${id}`, `<p>${id}</p>`, "en", "2026-01-01T00:00:00.000Z").run();
  }
}

describe("admin recorded email listing", () => {
  beforeEach(async () => {
    await bootstrapAdmin();
    await db().prepare("DELETE FROM recorded_emails").run();
    await seedEmails();
  });

  it("requires Access identity and does not accept a member session", async () => {
    expect((await api("GET", "/api/admin/recorded-emails")).status).toBe(403);
    expect((await api("GET", "/api/admin/recorded-emails", { session: "member-A" })).status).toBe(403);
    expect((await api("GET", "/api/admin/recorded-emails", { access: ACCESS })).status).toBe(200);
  });

  it("returns records in id order with bounded keyset pagination and no-store", async () => {
    const first = await api("GET", "/api/admin/recorded-emails?limit=2", { access: ACCESS });
    expect(first.status).toBe(200);
    expect(first.json).toEqual({
      ok: true,
      emails: [
        { id: "email-a", to_address: "a@example.test", subject: "Subject email-a", text_body: "Text email-a", html_body: "<p>email-a</p>", locale: "en", recorded_at: "2026-01-01T00:00:00.000Z" },
        { id: "email-b", to_address: "b@example.test", subject: "Subject email-b", text_body: "Text email-b", html_body: "<p>email-b</p>", locale: "en", recorded_at: "2026-01-01T00:00:00.000Z" },
      ],
      nextCursor: "email-b",
    });
    const second = await api("GET", `/api/admin/recorded-emails?limit=2&cursor=${first.json.nextCursor}`, { access: ACCESS });
    expect(second.json.emails.map((email: { id: string }) => email.id)).toEqual(["email-c"]);
    expect(second.json.nextCursor).toBeNull();

    const response = await (await import("cloudflare:workers")).exports.default.fetch(
      new Request("http://localhost/api/admin/recorded-emails", { headers: { "X-Stub-Access": ACCESS } }),
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects invalid limits and remains read only", async () => {
    for (const limit of ["0", "101", "1.5", "abc", ""]) {
      expect((await api("GET", `/api/admin/recorded-emails?limit=${limit}`, { access: ACCESS })).status).toBe(400);
    }
    const before = await db().prepare("SELECT * FROM recorded_emails ORDER BY id").all();
    expect((await api("POST", "/api/admin/recorded-emails", { access: ACCESS, body: {} })).status).toBe(403);
    const after = await db().prepare("SELECT * FROM recorded_emails ORDER BY id").all();
    expect(after.results).toEqual(before.results);
  });
});
