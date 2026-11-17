// Request path side of delivery: hand `queued` notification ids to the queue.
// A send, never an email. If the queue is absent or fails, rows stay `queued`
// with enqueued_at NULL and the sweeper retries: the D1 row is the record.
import type { Env } from "./types.ts";

export interface NotifyMessage { notification_ids: string[] }
const BATCH = 50;

export async function flushOutbox(env: Env): Promise<number> {
  if (!env.NOTIFY_Q) return 0;
  const rows = (await env.DB.prepare(`SELECT n.id FROM notifications n LEFT JOIN notification_prefs p ON p.user_id=n.user_id WHERE n.email_status='queued' AND n.enqueued_at IS NULL AND (COALESCE(p.delivery,'immediate')='immediate' OR n.digest_key IS NOT NULL OR n.email_delivery_key IS NOT NULL) ORDER BY n.id LIMIT 500`).all<{ id: string }>()).results;
  let sent = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const ids = rows.slice(i, i + BATCH).map((r) => r.id);
    try {
      await env.NOTIFY_Q.send({ notification_ids: ids });
    } catch (e) {
      console.log(JSON.stringify({ level: "error", event: "notify.enqueue_failed", error: String(e) }));
      break;
    }
    const q = ids.map((_, j) => `?${j + 2}`).join(",");
    await env.DB.prepare(`UPDATE notifications SET enqueued_at=?1 WHERE id IN (${q})`).bind(new Date().toISOString(), ...ids).run();
    sent += ids.length;
  }
  return sent;
}

/** Cron sweeper: re-enqueue stale `queued` rows (>5 min) and `failed` rows below the attempt cap. */
export async function sweep(env: Env, nowMs = Date.now(), maxAttempts = 5): Promise<number> {
  const cutoff = new Date(nowMs - 5 * 60_000).toISOString();
  await env.DB
    .prepare(`UPDATE notifications SET enqueued_at=NULL, email_status='queued'
               WHERE (email_status='queued' AND enqueued_at IS NOT NULL AND enqueued_at < ?1)
                  OR (email_status='failed' AND email_attempts < ?2)`)
    .bind(cutoff, maxAttempts)
    .run();
  // Freeze complete UTC days into immutable groups. A late request commit gets
  // a fresh key, so it cannot be swallowed by an already recorded digest.
  const boundary = new Date(nowMs).toISOString().slice(0, 10) + "T00:00:00.000Z";
  await env.DB.prepare(`WITH due AS MATERIALIZED (
      SELECT id,user_id FROM notifications
      WHERE email_status='queued' AND digest_key IS NULL AND email_delivery_key IS NULL AND created_at < ?1
        AND user_id IN (SELECT user_id FROM notification_prefs WHERE delivery='digest')
    ), groups AS MATERIALIZED (
      SELECT user_id,MIN(id) AS first_id FROM due GROUP BY user_id
    )
    UPDATE notifications SET email_delivery_key='digest:' ||
      (SELECT first_id FROM groups WHERE groups.user_id=notifications.user_id), digest_key='digest:' ||
      (SELECT first_id FROM groups WHERE groups.user_id=notifications.user_id), enqueued_at=NULL
    WHERE id IN (SELECT id FROM due)`)
    .bind(boundary).run();
  return flushOutbox(env);
}
