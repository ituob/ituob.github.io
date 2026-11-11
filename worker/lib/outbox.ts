// Request path side of delivery: hand `queued` notification ids to the queue.
// A send, never an email. If the queue is absent or fails, rows stay `queued`
// with enqueued_at NULL and the sweeper retries: the D1 row is the record.
import type { Env } from "./types.ts";

export interface NotifyMessage { notification_ids: string[] }
const BATCH = 50;

export async function flushOutbox(env: Env): Promise<number> {
  if (!env.NOTIFY_Q) return 0;
  const rows = (await env.DB.prepare(`SELECT id FROM notifications WHERE email_status='queued' AND enqueued_at IS NULL ORDER BY id LIMIT 500`).all<{ id: string }>()).results;
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
  return flushOutbox(env);
}
