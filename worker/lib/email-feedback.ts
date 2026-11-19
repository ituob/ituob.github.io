// Provider delivery feedback: bounce / complaint / delivered webhooks and the admin stats read.
// Trust path: a signature over the raw body (WebhookVerifier). Nothing is parsed before it passes.
// Idempotency needs no event table: every transition is a conditional UPDATE and every counter
// is bumped by changes(), so a replayed event changes nothing and counts nothing.
import type { Env } from "./types.ts";

export const MAX_FEEDBACK_BYTES = 256_000;
/** Svix signatures older/newer than this are refused (replay window). */
export const TIMESTAMP_TOLERANCE_S = 300;

export interface WebhookVerifier {
  /** True only for a request whose signature, over the raw body, the secret vouches for. */
  verify(secret: string, headers: Headers, raw: Uint8Array, nowMs: number): Promise<boolean>;
}

const b64 = (s: string): Uint8Array | null => {
  try { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); } catch { return null; }
};

/**
 * Svix scheme, used by Resend (the provider docs/email-configuration.adoc names):
 * headers svix-id, svix-timestamp, svix-signature ("v1,<base64>" , space-separated list);
 * signed content `${id}.${timestamp}.${body}`; key = base64 part of "whsec_<base64>".
 */
export const svixVerifier: WebhookVerifier = {
  async verify(secret, headers, raw, nowMs) {
    const id = headers.get("svix-id");
    const ts = headers.get("svix-timestamp");
    const sigs = headers.get("svix-signature");
    if (!id || !ts || !sigs || !/^\d{1,12}$/.test(ts)) return false;
    if (Math.abs(nowMs / 1000 - Number(ts)) > TIMESTAMP_TOLERANCE_S) return false;
    const keyBytes = b64(secret.replace(/^whsec_/, ""));
    if (!keyBytes || keyBytes.length === 0) return false;
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const prefix = new TextEncoder().encode(`${id}.${ts}.`);
    const signed = new Uint8Array(prefix.length + raw.length);
    signed.set(prefix);
    signed.set(raw, prefix.length);
    for (const part of sigs.split(" ")) {
      const [version, sig] = part.split(",");
      const bytes = version === "v1" && sig ? b64(sig) : null;
      if (bytes && (await crypto.subtle.verify("HMAC", key, bytes, signed))) return true; // constant-time
    }
    return false;
  },
};

export type Feedback =
  | { kind: "delivered" | "complained" | "bounced"; providerId: string; detail: string | null; to: string[] }
  | { kind: "ignored"; reason: string };

/** Map a Resend-shaped event. Only a Permanent bounce suppresses; soft bounces are the provider's to retry (docs). */
export function parseFeedback(payload: unknown): Feedback {
  const p = payload as { type?: unknown; data?: { email_id?: unknown; to?: unknown; bounce?: { type?: unknown; subType?: unknown; message?: unknown } } } | null;
  if (!p || typeof p !== "object" || typeof p.type !== "string") return { kind: "ignored", reason: "no event type" };
  const providerId = p.data?.email_id;
  if (p.type !== "email.bounced" && p.type !== "email.complained" && p.type !== "email.delivered") return { kind: "ignored", reason: "event" };
  if (typeof providerId !== "string" || providerId.length === 0 || providerId.length > 200) return { kind: "ignored", reason: "no email_id" };
  const to = (Array.isArray(p.data?.to) ? p.data.to : [p.data?.to]).filter((x): x is string => typeof x === "string").map((x) => x.trim().toLowerCase());
  if (p.type === "email.delivered") return { kind: "delivered", providerId, detail: null, to };
  if (p.type === "email.complained") return { kind: "complained", providerId, detail: null, to };
  if (p.data?.bounce?.type !== "Permanent") return { kind: "ignored", reason: "soft bounce" };
  const msg = p.data.bounce.message;
  return { kind: "bounced", providerId, detail: typeof msg === "string" ? msg.slice(0, 300) : null, to };
}

const FROM: Record<"delivered" | "bounced" | "complained", string> = {
  delivered: `'sent'`,
  bounced: `'sent','delivered'`,
  complained: `'sent','delivered','bounced'`,
};

/** Returns `unknown` when no notification carries the provider id (the send may not be recorded yet: the provider should retry). */
export async function applyFeedback(env: Env, f: Exclude<Feedback, { kind: "ignored" }>, now = new Date()): Promise<"applied" | "duplicate" | "unknown"> {
  const known = await env.DB.prepare(`SELECT 1 AS x FROM notifications WHERE email_provider_id=?1 LIMIT 1`).bind(f.providerId).first();
  if (!known) return "unknown";
  const day = now.toISOString().slice(0, 10);
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(`UPDATE notifications SET email_status=?2, email_reason=?3
        WHERE email_provider_id=?1 AND email_status IN (${FROM[f.kind]})`).bind(f.providerId, f.kind, f.detail),
    env.DB.prepare(`INSERT INTO notification_counters(day,metric,n) SELECT ?1,?2,changes()
        WHERE changes()>0 ON CONFLICT(day,metric) DO UPDATE SET n=n+excluded.n`).bind(day, f.kind),
  ];
  if (f.kind !== "delivered") {
    // Suppress the address the message was SENT to (recorded at send time), never the user's current
    // address (a login can change it). A row sent before the column existed has none: then only the
    // user's current address, and only when the signed event's own recipient list names it.
    // WHERE changes()>0 reads the counter statement above, which changes a row iff the status UPDATE did,
    // so a redelivered event cannot recreate a suppression an admin deleted.
    // Never overwrites an existing row (a manual suppression stays manual).
    stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO email_suppressions(email,reason,first_seen,detail)
        SELECT DISTINCT COALESCE(n.email_to, u.email), ?2, ?3, ?4 FROM notifications n JOIN users u ON u.id=n.user_id
        WHERE changes()>0 AND n.email_provider_id=?1 AND COALESCE(n.email_to, u.email) IS NOT NULL AND COALESCE(n.email_to, u.email)<>''
          AND (n.email_to IS NOT NULL OR lower(u.email) IN (SELECT value FROM json_each(?5)))`)
      .bind(f.providerId, f.kind === "bounced" ? "hard_bounce" : "complaint", now.toISOString(), f.detail, JSON.stringify(f.to)));
  }
  const [update] = await env.DB.batch(stmts);
  return update!.meta.changes > 0 ? "applied" : "duplicate";
}

export async function handleFeedbackWebhook(request: Request, env: Env, verifier: WebhookVerifier = svixVerifier): Promise<Response> {
  const json = (b: unknown, status: number) => Response.json(b, { status, headers: { "Cache-Control": "no-store" } });
  const secret = env.EMAIL_WEBHOOK_SECRET;
  if (!secret) return json({ error: "webhook not configured" }, 503); // fail closed
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_FEEDBACK_BYTES) return json({ error: "payload too large" }, 413);
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.byteLength > MAX_FEEDBACK_BYTES) return json({ error: "payload too large" }, 413);
  if (!(await verifier.verify(secret, request.headers, raw, Date.now()))) return json({ error: "invalid signature" }, 401);
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder().decode(raw)); } catch { return json({ error: "body is not JSON" }, 400); }
  const f = parseFeedback(payload);
  if (f.kind === "ignored") return json({ ok: true, status: "ignored", reason: f.reason }, 200);
  const result = await applyFeedback(env, f);
  if (result === "unknown") return json({ error: "unknown message, redeliver" }, 404);
  return json({ ok: true, status: result }, 200);
}

const DAYS = 14;
export async function notificationStats(env: Env, now = new Date()) {
  const since = new Date(now.getTime() - (DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
  const counters = (await env.DB.prepare(`SELECT day, metric, n FROM notification_counters WHERE day>=?1 ORDER BY day DESC, metric`)
    .bind(since).all<{ day: string; metric: string; n: number }>()).results;
  const days: Record<string, Record<string, number>> = {};
  const totals: Record<string, number> = {};
  for (const c of counters) {
    (days[c.day] ??= {})[c.metric] = c.n;
    totals[c.metric] = (totals[c.metric] ?? 0) + c.n;
  }
  const suppressions = (await env.DB.prepare(`SELECT reason, COUNT(*) AS n FROM email_suppressions GROUP BY reason`)
    .all<{ reason: string; n: number }>()).results;
  const recent = (await env.DB.prepare(`SELECT email, reason, first_seen, detail FROM email_suppressions ORDER BY first_seen DESC, email LIMIT 20`).all()).results;
  const status = (await env.DB.prepare(`SELECT email_status AS status, COUNT(*) AS n FROM notifications GROUP BY email_status`)
    .all<{ status: string; n: number }>()).results;
  return {
    ok: true, since, days, totals,
    suppressions: Object.fromEntries(suppressions.map((s) => [s.reason, s.n])),
    recentSuppressions: recent,
    notificationStatus: Object.fromEntries(status.map((s) => [s.status, s.n])),
  };
}
