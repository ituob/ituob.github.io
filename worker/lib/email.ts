// The one-function email seam (design D1). ONLY worker/queue-consumer.ts may
// import this module: a test asserts that no request-path module does.
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /** notification.id: the provider dedupes redeliveries by this key. */
  idempotencyKey: string;
}
export interface EmailSender {
  send(msg: EmailMessage): Promise<{ id: string }>;
}

export interface EmailConfig {
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
}

/** Called only by the queue consumer; retries retain the notification's key. */
export class ResendEmailSender implements EmailSender {
  constructor(private readonly config: EmailConfig, private readonly fetcher: typeof fetch = fetch) {}

  async send(msg: EmailMessage): Promise<{ id: string }> {
    if (!this.config.RESEND_API_KEY || !this.config.MAIL_FROM) throw new Error("email provider not configured");
    const response = await this.fetcher("https://api.resend.com/emails", {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${this.config.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": msg.idempotencyKey,
      },
      body: JSON.stringify({ from: this.config.MAIL_FROM, to: [msg.to], subject: msg.subject, text: msg.text }),
    });
    if (!response.ok) throw new Error(`email provider returned ${response.status}`);
    const result = await response.json() as { id?: unknown };
    if (typeof result.id !== "string" || !result.id) throw new Error("email provider returned missing email id");
    return { id: result.id };
  }
}

/** Real provider placeholder: no account is configured, so it always fails (and is retried/counted). */
export class UnconfiguredEmailSender implements EmailSender {
  async send(): Promise<{ id: string }> {
    throw new Error("email provider not configured");
  }
}

export class FakeEmailSender implements EmailSender {
  sent: EmailMessage[] = [];
  /** Fail the next N sends (simulates a provider 5xx), then recover. */
  failNext = 0;
  private byKey = new Map<string, { id: string }>();
  async send(msg: EmailMessage): Promise<{ id: string }> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("provider 503");
    }
    const hit = this.byKey.get(msg.idempotencyKey);
    if (hit) return hit;
    this.sent.push(msg);
    const r = { id: `fake-${this.sent.length}` };
    this.byKey.set(msg.idempotencyKey, r);
    return r;
  }
}

let override: EmailSender | null = null;
export function setEmailSender(s: EmailSender | null) {
  override = s;
}
export function getEmailSender(config?: EmailConfig): EmailSender {
  return override ?? (config ? new ResendEmailSender(config) : new UnconfiguredEmailSender());
}
