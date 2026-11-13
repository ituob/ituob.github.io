// The ONLY module that talks to the email provider (design invariant 1).
import { getEmailSender } from "./lib/email.ts";
import { renderEmail, emailAllowed, type Level } from "./lib/notify.ts";
import type { NotifyMessage } from "./lib/outbox.ts";
import type { Env } from "./lib/types.ts";

export const MAX_ATTEMPTS = 5;
const day = () => new Date().toISOString().slice(0, 10);

const count = (env: Env, metric: string) =>
  env.DB.prepare(`INSERT INTO notification_counters (day,metric,n) VALUES (?1,?2,1) ON CONFLICT (day,metric) DO UPDATE SET n=n+1`).bind(day(), metric);

/** Returns true if the notification needs another attempt. */
async function deliver(env: Env, id: string): Promise<boolean> {
  const n = await env.DB
    .prepare(
      `SELECT n.*, u.email AS email, COALESCE(p.level,'all') AS level,
              EXISTS (SELECT 1 FROM email_suppressions s WHERE s.email=u.email) AS suppressed
         FROM notifications n JOIN users u ON u.id=n.user_id LEFT JOIN notification_prefs p ON p.user_id=n.user_id
        WHERE n.id=?1`,
    )
    .bind(id)
    .first<any>();
  if (!n || (n.email_status !== "queued" && n.email_status !== "failed")) return false; // already sent/skipped: redelivery is a no-op
  const skip = async (reason: string, metric: string) => {
    await env.DB.batch([
      env.DB.prepare(`UPDATE notifications SET email_status='skipped', email_reason=?2 WHERE id=?1`).bind(id, reason),
      count(env, metric),
    ]);
    return false;
  };
  if (!n.email) return skip("skipped:no_address", "skipped_no_address");
  if (!emailAllowed(n.kind, n.level as Level)) return skip("skipped:prefs", "skipped_prefs");
  if (n.suppressed) return skip("skipped:suppressed", "skipped_suppressed");
  const mail = renderEmail(n);
  try {
    const r = await getEmailSender(env).send({ to: n.email, subject: mail.subject, text: mail.text, idempotencyKey: n.id });
    await env.DB.batch([
      env.DB.prepare(`UPDATE notifications SET email_status='sent', email_provider_id=?2, email_sent_at=?3, email_attempts=email_attempts+1, email_reason=NULL WHERE id=?1`).bind(id, r.id, new Date().toISOString()),
      count(env, "sent"),
    ]);
    return false;
  } catch (e) {
    const msg = String((e as Error).message ?? e).slice(0, 300);
    const attempts = n.email_attempts + 1;
    const dead = attempts >= MAX_ATTEMPTS;
    await env.DB.batch([
      env.DB.prepare(`UPDATE notifications SET email_status='failed', email_attempts=?2, email_reason=?3 WHERE id=?1`).bind(id, attempts, dead ? `dead: ${msg}` : msg),
      count(env, "failed"),
      ...(dead ? [count(env, "dlq")] : []),
    ]);
    console.log(JSON.stringify({ level: dead ? "error" : "warn", event: "notify.send_failed", notification_id: id, kind: n.kind, attempt: attempts, error: msg }));
    return !dead;
  }
}

/** Queue consumer: a failure retries the message with exponential delay; the row is never lost. */
export async function handleQueue(batch: MessageBatch<NotifyMessage>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    let retry = false;
    for (const id of msg.body.notification_ids) if (await deliver(env, id)) retry = true;
    if (retry) msg.retry({ delaySeconds: Math.min(300, 2 ** msg.attempts * 5) });
    else msg.ack();
  }
}
