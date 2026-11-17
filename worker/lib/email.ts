import type { Env } from "./types.ts";

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

/** Sends nothing: writes a structured log line (no body text) and returns a deterministic id. For staging/dev. */
export class LogEmailSender implements EmailSender {
  async send(msg: EmailMessage): Promise<{ id: string }> {
    console.log(JSON.stringify({ level: "info", event: "email.logged", to: msg.to, subject: msg.subject, idempotency_key: msg.idempotencyKey }));
    return { id: `log-${msg.idempotencyKey}` };
  }
}

/**
 * Generic HTTPS JSON provider (Resend-compatible: POST {from,to,subject,text}
 * with a Bearer key, `Idempotency-Key` header, `{id}` in the response). Any
 * non-2xx or malformed response throws so the consumer retries/counts it.
 */
export class HttpEmailSender implements EmailSender {
  constructor(
    private readonly url: string,
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetcher: typeof fetch = (...a) => fetch(...a),
  ) {}
  async send(msg: EmailMessage): Promise<{ id: string }> {
    const res = await this.fetcher(this.url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": msg.idempotencyKey,
      },
      body: JSON.stringify({ from: this.from, to: [msg.to], subject: msg.subject, text: msg.text }),
    });
    if (!res.ok) throw new Error(`email provider ${res.status}`);
    const body = (await res.json().catch(() => null)) as { id?: unknown } | null;
    if (!body || typeof body.id !== "string" || !body.id) throw new Error("email provider response lacked an id");
    return { id: body.id.slice(0, 200) };
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
/** https only, no userinfo, no loopback/IP-literal/single-label host; returns the normalized URL or null. */
export function safeHttpsEndpoint(raw: string | undefined): string | null {
  try {
    const u = new URL((raw ?? "").trim());
    const h = u.hostname;
    if (u.protocol !== "https:" || u.username || u.password) return null;
    if (!h.includes(".") || h === "localhost" || h.endsWith(".localhost") || h.startsWith("[") || /^[\d.]+$/.test(h)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** Strip URL query strings, bearer tokens and the configured API key from text bound for storage or logs. */
export function redactSecrets(text: string, ...secrets: (string | undefined)[]): string {
  let out = text.replace(/(https?:\/\/[^\s"'<>?#]*)[?#][^\s"'<>]*/gi, "$1?[redacted]").replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]");
  for (const s of secrets) if (s && s.trim().length >= 4) out = out.split(s.trim()).join("[redacted]");
  return out;
}

/**
 * Config-selected provider. EMAIL_PROVIDER="log" -> LogEmailSender; "http" ->
 * HttpEmailSender (needs EMAIL_API_URL https, EMAIL_API_KEY, MAIL_FROM);
 * anything else, or incomplete config, -> UnconfiguredEmailSender (fails closed).
 */
export function getEmailSender(env?: Env, fetcher?: typeof fetch): EmailSender {
  if (override) return override;
  if (env?.EMAIL_PROVIDER === "log") return new LogEmailSender();
  if (env?.EMAIL_PROVIDER === "http") {
    const key = env.EMAIL_API_KEY?.trim();
    const from = env.MAIL_FROM?.trim();
    const url = safeHttpsEndpoint(env.EMAIL_API_URL);
    if (key && from && url) return new HttpEmailSender(url, key, from, fetcher);
  }
  return new UnconfiguredEmailSender();
}
