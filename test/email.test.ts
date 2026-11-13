import { afterEach, describe, expect, it, vi } from "vitest";
import { getEmailSender, ResendEmailSender, setEmailSender } from "../worker/lib/email.ts";

afterEach(() => setEmailSender(null));

const message = { to: "member@example.test", subject: "Submission reviewed", text: "Please revise your submission.", idempotencyKey: "notification-123" };

describe("configured queued email delivery", () => {
  it("sends plain text to Resend with a stable idempotency key", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: "email-123" }));
    const sender = new ResendEmailSender({ RESEND_API_KEY: "test-secret", MAIL_FROM: "Bulletin <ob@example.test>" }, fetcher);
    await expect(sender.send(message)).resolves.toEqual({ id: "email-123" });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    const headers = new Headers(init!.headers);
    expect(headers.get("Authorization")).toBe("Bearer test-secret");
    expect(headers.get("Idempotency-Key")).toBe(message.idempotencyKey);
    expect(JSON.parse(String(init!.body))).toEqual({ from: "Bulletin <ob@example.test>", to: [message.to], subject: message.subject, text: message.text });
    expect(init!.redirect).toBe("error");
  });

  it("fails closed without a sender address or API key", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new ResendEmailSender({ RESEND_API_KEY: "test-secret" }, fetcher).send(message)).rejects.toThrow("not configured");
    await expect(getEmailSender().send(message)).rejects.toThrow("not configured");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("leaves upstream failures retryable without leaking provider response bodies", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("private upstream content", { status: 429 }));
    await expect(new ResendEmailSender({ RESEND_API_KEY: "test-secret", MAIL_FROM: "ob@example.test" }, fetcher).send(message)).rejects.toThrow("email provider returned 429");
  });

  it("does not treat a malformed success as a delivered email", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ unexpected: "shape" }));
    await expect(new ResendEmailSender({ RESEND_API_KEY: "test-secret", MAIL_FROM: "ob@example.test" }, fetcher).send(message)).rejects.toThrow("missing email id");
  });
});
