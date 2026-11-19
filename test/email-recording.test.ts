import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as email from "../worker/lib/email.ts";
import * as notify from "../worker/lib/notify.ts";
import type { Env } from "../worker/lib/types.ts";

const notification = {
  id: "render-n1", submission_id: "submission/unsafe\"", kind: "submission.changes_requested",
  payload: JSON.stringify({ register_id: "E.164", slug: "<script>alert('x')</script>", actor_name: 'A & "B"', reason: "<img src=x onerror=alert(1)>", excerpt: "Review <this> & that" }),
};

describe("localized notification messages", () => {
  it("renders human English titles, escaped HTML and absolute action/preferences links", () => {
    const mail = notify.renderEmail(notification);
    expect(mail.locale).toBe("en");
    expect(mail.subject).toContain("Changes requested");
    expect(mail.text).toContain("Reason: <img src=x onerror=alert(1)>");
    expect(mail.text).toContain("https://www.ituob.org/me/discussions/?id=submission%2Funsafe%22");
    expect(mail.text).toContain("https://www.ituob.org/api/me/notification-prefs");
    expect(mail.html).toContain("&lt;script&gt;");
    expect(mail.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(mail.html).toContain("A &amp; &quot;B&quot;");
    expect(mail.html).not.toMatch(/<script|<img/);
  });

  it("uses recipient locale and configured origin, falling back to English", () => {
    const french = notify.renderEmail(notification, { locale: "fr-CA", origin: "https://staging.example.org/base" });
    expect(french.locale).toBe("fr");
    expect(french.subject).toContain("Modifications demandées");
    expect(french.text).toContain("Par : A &");
    expect(french.text).toContain("https://staging.example.org/me/discussions/?id=");
    expect(french.html).toContain('lang="fr"');
    expect(notify.renderEmail(notification, { locale: "es" }).subject).toContain("Cambios solicitados");
    expect(notify.renderEmail(notification, { locale: "unknown" }).locale).toBe("en");
    expect(notify.renderEmail(notification, { locale: null }).locale).toBe("en");
  });

  it("names the OB issue an item was scheduled into, in the recipient's language", () => {
    const scheduled = { ...notification, kind: "submission.scheduled", payload: JSON.stringify({ register_id: "E.164", slug: "x", edition: 1351 }) };
    expect(notify.renderEmail(scheduled).text).toContain("Operational Bulletin No. 1351");
    expect(notify.renderEmail(scheduled, { locale: "fr" }).text).toContain("Bulletin d'exploitation n° 1351");
    expect(notify.renderEmail(scheduled, { locale: "zh" }).text).toContain("操作公报第1351期");
    expect(notify.renderEmail(notification).text).not.toContain("Operational Bulletin");
  });

  it("names the OB issue on unscheduled and published emails too", () => {
    for (const kind of ["submission.unscheduled", "submission.published"]) {
      const event = { ...notification, kind, payload: JSON.stringify({ register_id: "E.164", slug: "x", edition: 1352 }) };
      expect(notify.renderEmail(event).text).toContain("Operational Bulletin No. 1352");
    }
  });

  it("renders a localized digest containing every event, with safe fallback event titles", () => {
    const second = { ...notification, id: "n2", kind: "<custom>", payload: "{}" };
    const digest = notify.renderDigestEmail([notification, second], { locale: "es" });
    expect(digest.locale).toBe("es");
    expect(digest.subject).toContain("Resumen de notificaciones");
    expect(digest.text).toContain("Cambios solicitados");
    expect(digest.text).toContain("Actualización de la presentación");
    expect(digest.html).toContain("&lt;script&gt;");
    expect(digest.html).not.toContain("<custom>");
    expect((digest.text.match(/https:\/\/www\.ituob\.org\/me\/discussions\/\?id=/g) ?? []).length).toBe(2);
    expect(digest.text).toContain("https://www.ituob.org/api/me/notification-prefs");
  });

  it("provides a human title for every current event", () => {
    for (const kind of [...Object.values(notify.STATE_EVENT), "comment.mention", "comment.reply", "comment.created", "discussion.closed", "discussion.reopened"]) {
      const mail = notify.renderEmail({ ...notification, kind });
      expect(mail.subject).not.toContain(kind);
    }
    expect(notify.renderEmail({ ...notification, kind: "constructor" }).subject).toContain("Submission update");
    expect(notify.renderEmail(notification, { origin: "javascript:alert(1)" }).html).not.toContain('href="javascript:');
  });

  it.each([
    ["ru", "Запрошены изменения", "Сводка уведомлений", "Настройки уведомлений", "Обновление заявки"],
    ["zh", "需要修改", "通知摘要", "通知偏好设置", "提交内容更新"],
    ["ar", "طُلبت تعديلات", "ملخص الإشعارات", "تفضيلات الإشعارات", "تحديث الطلب"],
  ])("renders the supported %s locale in immediate and digest messages", (locale, event, heading, preferences, fallback) => {
    const mail = notify.renderEmail(notification, { locale });
    expect(mail.locale).toBe(locale);
    expect(mail.subject).toContain(event);
    expect(mail.html).toContain(`lang="${locale}"`);
    expect(mail.html).toContain(preferences);
    expect(mail.text).toContain(preferences);
    expect(mail.html).toContain("&lt;script&gt;");
    if (locale === "ar") expect(mail.html).toContain('dir="rtl"');
    const digest = notify.renderDigestEmail([notification], { locale });
    expect(digest.locale).toBe(locale);
    expect(digest.subject).toContain(heading);
    expect(digest.text).toContain(event);
    expect(digest.html).toContain(preferences);
    if (locale === "ar") expect(digest.html).toContain('dir="rtl"');
    for (const kind of [...Object.values(notify.STATE_EVENT), "comment.mention", "comment.reply", "comment.created", "discussion.closed", "discussion.reopened"]) {
      const subject = notify.renderEmail({ ...notification, kind }, { locale }).subject;
      expect(subject).not.toContain(kind);
      expect(subject).not.toContain(fallback);
    }
    expect(notify.renderEmail({ ...notification, kind: "unknown.event" }, { locale }).subject).toContain(fallback);
  });

  it("includes rendered HTML in the HTTP provider while retaining the plain text alternative", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ id: "rendered" }));
    const rendered = notify.renderEmail(notification, { locale: "es" });
    await new email.HttpEmailSender("https://mail.example.org/send", "key", "a@example.org", fetcher)
      .send({ to: "b@example.org", ...rendered, idempotencyKey: "http-html" });
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toMatchObject({ text: rendered.text, html: rendered.html });
  });
});

describe("durable recording provider", () => {
  beforeEach(async () => {
    email.setEmailSender(null);
    await env.DB.prepare("DELETE FROM recorded_emails").run();
  });

  it("selects recording without credentials, stores both bodies and dedupes across instances", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const config = { DB: env.DB, EMAIL_PROVIDER: "recording" } as Env;
    const sender = email.getEmailSender(config, fetcher);
    expect(sender).toBeInstanceOf(email.RecordingEmailSender);
    const message = { to: "recipient@example.org", ...notify.renderEmail(notification, { locale: "fr" }), idempotencyKey: "record-n1" };
    expect(await sender.send(message)).toEqual({ id: "recording-record-n1" });
    expect(await email.getEmailSender(config).send({ ...message, text: "duplicate changed body" })).toEqual({ id: "recording-record-n1" });
    const rows = (await env.DB.prepare("SELECT * FROM recorded_emails").all()).results;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "recording-record-n1", to_address: message.to, subject: message.subject, text_body: message.text, html_body: message.html, locale: "fr" });
    expect(Number.isNaN(Date.parse(String(rows[0]!.recorded_at)))).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("accepts older text-only messages and surfaces storage failures", async () => {
    const sender = email.getEmailSender({ DB: env.DB, EMAIL_PROVIDER: "recording" } as Env);
    await sender.send({ to: "old@example.org", subject: "Old", text: "plain", idempotencyKey: "old" });
    expect(await env.DB.prepare("SELECT html_body,locale FROM recorded_emails WHERE id='recording-old'").first()).toEqual({ html_body: "", locale: "en" });
    const failedDb = { prepare: () => { throw new Error("database unavailable"); } } as unknown as D1Database;
    await expect(new email.RecordingEmailSender(failedDb).send({ to: "a@b.org", subject: "x", text: "x", idempotencyKey: "failed" })).rejects.toThrow("database unavailable");
  });
});
