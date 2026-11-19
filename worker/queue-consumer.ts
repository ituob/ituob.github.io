// The ONLY module that talks to the email sender. Requests only enqueue ids.
import { getEmailSender, redactSecrets } from "./lib/email.ts";
import { renderEmail, renderDigestEmail, emailAllowed, type Level } from "./lib/notify.ts";
import type { NotifyMessage } from "./lib/outbox.ts";
import type { Env } from "./lib/types.ts";

export const MAX_ATTEMPTS = 5;
const count = (env: Env, metric: string, n = 1) =>
  env.DB.prepare(`INSERT INTO notification_counters (day,metric,n) VALUES (?1,?2,?3) ON CONFLICT (day,metric) DO UPDATE SET n=n+excluded.n`)
    .bind(new Date().toISOString().slice(0, 10), metric, n);

interface Notification {
  id: string; kind: string; payload: string; submission_id: string;
  email: string | null; locale: string | null; level: Level; suppressed: number;
  delivery: string; digest_key: string | null; email_delivery_key: string | null; email_status: string;
  email_provider_id: string | null; email_attempts: number;
}
const query = `SELECT n.*, u.email, u.locale, COALESCE(p.level,'all') AS level,
  COALESCE(p.delivery,'immediate') AS delivery,
  EXISTS (SELECT 1 FROM email_suppressions s WHERE s.email=u.email) AS suppressed
  FROM notifications n JOIN users u ON u.id=n.user_id
  LEFT JOIN notification_prefs p ON p.user_id=n.user_id`;
const pending = (n: Notification) => n.email_status === "queued" || n.email_status === "failed";

/** Apply current consent even to an old queued message. Digest rows wait for cron. */
async function eligible(env: Env, n: Notification): Promise<boolean> {
  if (!pending(n) || n.email_attempts >= MAX_ATTEMPTS) return false;
  if (n.email_provider_id) {
    await env.DB.prepare(`UPDATE notifications SET email_status='sent' WHERE id=?1`).bind(n.id).run();
    return false;
  }
  const reason = !n.email ? "no_address" : !emailAllowed(n.kind, n.level) ? "prefs" : n.suppressed ? "suppressed" : null;
  if (reason) {
    await env.DB.batch([
      count(env, `skipped_${reason}`),
      env.DB.prepare(`UPDATE notifications SET email_status='skipped', email_reason=?2 WHERE id=?1`).bind(n.id, `skipped:${reason}`),
    ]);
    return false;
  }
  return n.delivery !== "digest" || n.digest_key !== null || n.email_delivery_key !== null;
}

/** A digest key freezes the membership of a daily group across queue retries. */
async function deliver(env: Env, first: Notification): Promise<boolean> {
  // Freeze identity atomically against cron's digest assignment. Replays may
  // share the provider key, but can never move this recipient into another send.
  const claim = await env.DB.prepare(`UPDATE notifications
    SET email_delivery_key=COALESCE(email_delivery_key,digest_key,id)
    WHERE id=?1 AND email_status IN ('queued','failed')
      AND (email_delivery_key IS NOT NULL OR digest_key IS NOT NULL OR
        COALESCE((SELECT delivery FROM notification_prefs WHERE user_id=notifications.user_id),'immediate')='immediate')
    RETURNING digest_key,email_delivery_key`).bind(first.id)
    .first<{ digest_key: string | null; email_delivery_key: string }>();
  if (!claim) return false;
  // Cron may have won the claim since the caller's SELECT.
  first = (await env.DB.prepare(`${query} WHERE n.id=?1`).bind(first.id).first<Notification>())!;
  const group = first.digest_key
    ? (await env.DB.prepare(`${query} WHERE n.digest_key=?1 ORDER BY n.created_at,n.id`).bind(first.digest_key).all<Notification>()).results
    : [first];
  const ready: Notification[] = [];
  for (const n of group) if (await eligible(env, n)) ready.push(n);
  if (!ready.length) return false;
  const options = { locale: ready[0]!.locale };
  const mail = first.digest_key ? renderDigestEmail(ready, options) : renderEmail(ready[0]!, options);
  try {
    const result = await getEmailSender(env).send({
      to: ready[0]!.email!, ...mail, idempotencyKey: claim.email_delivery_key,
    });
    // Conditional updates make repeated/concurrent deliveries leave counters unchanged.
    const statements: D1PreparedStatement[] = [];
    for (const n of ready) {
      statements.push(
        env.DB.prepare(`UPDATE notifications SET email_status='sent',email_provider_id=?2,email_sent_at=?3,email_to=?4,
          email_attempts=email_attempts+1,email_reason=NULL WHERE id=?1 AND email_status IN ('queued','failed')`)
          .bind(n.id, result.id, new Date().toISOString(), ready[0]!.email),
        env.DB.prepare(`INSERT INTO notification_counters(day,metric,n) SELECT ?1,'sent',changes()
          WHERE changes()>0 ON CONFLICT(day,metric) DO UPDATE SET n=n+excluded.n`)
          .bind(new Date().toISOString().slice(0, 10)),
      );
    }
    await env.DB.batch(statements);
    return false;
  } catch (e) {
    const error = redactSecrets(String((e as Error).message ?? e), env.EMAIL_API_KEY, env.EMAIL_API_URL).slice(0, 300);
    let retry = false;
    for (const n of ready) {
      // Increment and arbitrate against a successful consumer in one statement.
      // Counter inserts observe changes() inside the same D1 transaction.
      const day = new Date().toISOString().slice(0, 10);
      const [transition] = await env.DB.batch<{ email_attempts: number }>([
        env.DB.prepare(`UPDATE notifications SET email_status='failed', email_attempts=email_attempts+1,
          email_reason=CASE WHEN email_attempts+1>=?2 THEN 'dead: ' || ?3 ELSE ?3 END
          WHERE id=?1 AND email_status IN ('queued','failed') AND email_provider_id IS NULL
          RETURNING email_attempts`).bind(n.id, MAX_ATTEMPTS, error),
        env.DB.prepare(`INSERT INTO notification_counters(day,metric,n) SELECT ?1,'failed',1
          WHERE changes()>0 ON CONFLICT(day,metric) DO UPDATE SET n=n+excluded.n`).bind(day),
        env.DB.prepare(`INSERT INTO notification_counters(day,metric,n) SELECT ?1,'dlq',1
          WHERE changes()>0 AND EXISTS (SELECT 1 FROM notifications WHERE id=?2
            AND email_status='failed' AND email_attempts=?3)
          ON CONFLICT(day,metric) DO UPDATE SET n=n+excluded.n`).bind(day, n.id, MAX_ATTEMPTS),
      ]);
      const updated = transition!.results[0];
      if (!updated) continue;
      const attempts = updated.email_attempts;
      const dead = attempts >= MAX_ATTEMPTS;
      retry ||= !dead;
      console.log(JSON.stringify({ level: dead ? "error" : "warn", event: "notify.send_failed", notification_id: n.id, kind: n.kind, attempt: attempts, error }));
    }
    return retry;
  }
}

/** Unexpected D1 failures retry too; no queue message is acknowledged on lost work. */
export async function handleQueue(batch: MessageBatch<NotifyMessage>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    let retry = false;
    const seen = new Set<string>();
    try {
      for (const id of msg.body.notification_ids) {
        const n = await env.DB.prepare(`${query} WHERE n.id=?1`).bind(id).first<Notification>();
        if (!n) continue;
        const key = n.digest_key ?? n.id;
        if (seen.has(key)) continue;
        seen.add(key);
        if (await deliver(env, n)) retry = true;
      }
    } catch (e) {
      retry = true;
      console.log(JSON.stringify({ level: "error", event: "notify.consume_failed", error: redactSecrets(String(e), env.EMAIL_API_KEY, env.EMAIL_API_URL) }));
    }
    if (retry) msg.retry({ delaySeconds: Math.min(300, 2 ** msg.attempts * 5) });
    else msg.ack();
  }
}
