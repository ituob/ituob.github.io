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
export function getEmailSender(): EmailSender {
  return override ?? new UnconfiguredEmailSender();
}
