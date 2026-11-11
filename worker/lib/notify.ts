// Event emission (#104). Pure recipient rules + the statements that write
// notification rows INSIDE the caller's db.batch, so a rolled-back transition
// leaves no notification and a committed one cannot lack it. Never sends email.
import { ulid } from "./ulid.ts";

export type Level = "all" | "mentions" | "none";

export const STATE_EVENT: Record<string, string> = {
  submitted: "submission.submitted",
  in_review: "submission.in_review",
  changes_requested: "submission.changes_requested",
  approved: "submission.approved",
  rejected: "submission.rejected",
  withdrawn: "submission.withdrawn",
  pr_open: "submission.pr_opened",
  ci_failed: "submission.ci_failed",
  merged: "submission.pr_merged",
  published: "submission.published",
};
/** Emailed even at level `mentions` (action required, design rule 1 / D3). */
const ACTIONABLE = new Set(["submission.changes_requested", "submission.rejected"]);
/** "To me" events honoured at level `mentions`. */
const TO_ME = new Set(["comment.mention", "comment.reply"]);

/** Whether an email is allowed for this event at this level. `none` is literal. */
export function emailAllowed(kind: string, level: Level): boolean {
  if (level === "none") return false;
  if (level === "all") return true;
  return TO_ME.has(kind) || ACTIONABLE.has(kind);
}

export interface Recipient { userId: string; email: string | null; level: Level; suppressed: boolean }

interface Ctx {
  submissionId: string;
  proposerId: string;
  kind: string;
  actorId: string | null;
  refType: string;
  refId: string;
  payload: Record<string, unknown>;
  at: string;
  /** Explicit recipients (comment events); otherwise derived from the kind. */
  userIds?: string[];
  /** Only inserted if the submission is still at this version (same batch as the transition). */
  version?: number;
}

const ITU_Q = (roles: string) =>
  `SELECT DISTINCT u.id FROM users u JOIN memberships m ON m.user_id=u.id AND m.kind='itu' AND m.status='active'
     JOIN user_roles r ON r.user_id=u.id AND r.role IN (${roles})`;

export async function ituUsers(db: D1Database, admins: boolean, editors: boolean): Promise<string[]> {
  const roles = [editors && "'itu-editor'", admins && "'itu-admin'"].filter(Boolean).join(",");
  if (!roles) return [];
  return (await db.prepare(ITU_Q(roles)).all<{ id: string }>()).results.map((r) => r.id);
}

async function participantIds(db: D1Database, submissionId: string, roles: string[]): Promise<string[]> {
  const q = roles.map((_, i) => `?${i + 2}`).join(",");
  return (await db.prepare(`SELECT DISTINCT user_id FROM submission_participants WHERE submission_id=?1 AND role IN (${q})`).bind(submissionId, ...roles).all<{ user_id: string }>()).results.map((r) => r.user_id);
}

/** Matrix of the design note: who hears about a transition event. */
export async function transitionRecipients(db: D1Database, kind: string, submissionId: string, proposerId: string): Promise<string[]> {
  const P = [proposerId];
  const CW = await participantIds(db, submissionId, ["contact", "watcher"]);
  const R = await ituUsers(db, false, true);
  const A = await ituUsers(db, true, false);
  switch (kind) {
    case "submission.submitted": return [...R, ...(R.length ? [] : A)];
    case "submission.in_review": return [...P, ...(await participantIds(db, submissionId, ["contact"]))];
    case "submission.changes_requested":
    case "submission.rejected": return [...P, ...CW];
    case "submission.approved":
    case "submission.published": return [...P, ...CW, ...A];
    case "submission.pr_opened":
    case "submission.pr_merged": return [...P, ...(await participantIds(db, submissionId, ["watcher"])), ...A];
    case "submission.ci_failed": return [...R, ...A];
    case "submission.withdrawn": return [...P, ...R, ...CW];
    case "discussion.closed":
    case "discussion.reopened": return [...P, ...R, ...CW];
    default: return [];
  }
}

/**
 * Statements inserting one notification row per recipient (never the actor),
 * idempotent by dedupe_key. Prefs, address and suppression are applied here so
 * the row records `skipped:*` honestly; the inbox row always exists.
 */
export async function notifyStatements(db: D1Database, c: Ctx, candidates?: string[]): Promise<D1PreparedStatement[]> {
  const ids = [...new Set(candidates ?? c.userIds ?? (await transitionRecipients(db, c.kind, c.submissionId, c.proposerId)))].filter((u) => u !== c.actorId);
  const out: D1PreparedStatement[] = [];
  for (const userId of ids) {
    const u = await db
      .prepare(
        `SELECT u.email AS email, COALESCE(p.level,'all') AS level,
                EXISTS (SELECT 1 FROM email_suppressions s WHERE s.email = u.email) AS suppressed
           FROM users u LEFT JOIN notification_prefs p ON p.user_id=u.id WHERE u.id=?1`,
      )
      .bind(userId)
      .first<{ email: string | null; level: Level; suppressed: number }>();
    if (!u) continue;
    let status = "queued";
    let reason: string | null = null;
    if (!u.email) { status = "skipped"; reason = "skipped:no_address"; }
    else if (!emailAllowed(c.kind, u.level)) { status = "skipped"; reason = "skipped:prefs"; }
    else if (u.suppressed) { status = "skipped"; reason = "skipped:suppressed"; }
    const args = [ulid(), userId, c.submissionId, c.kind, c.refType, c.refId, `${c.kind}:${c.refId}:${userId}`, JSON.stringify(c.payload), c.at, status, reason];
    const guard = c.version === undefined ? "" : ` WHERE EXISTS (SELECT 1 FROM submissions WHERE id=?12 AND version=?13)`;
    out.push(
      db
        .prepare(
          `INSERT INTO notifications (id,user_id,submission_id,kind,ref_type,ref_id,dedupe_key,payload,created_at,email_status,email_reason)
           SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11${guard} ON CONFLICT (dedupe_key) DO NOTHING`,
        )
        .bind(...args, ...(c.version === undefined ? [] : [c.submissionId, c.version])),
    );
  }
  return out;
}

export interface TransitionInfo {
  sub: { id: string; proposer_id: string; register_id: string; slug: string };
  chain: string[];
  actorId: string | null;
  reason: string | null;
  rev: number;
  at: string;
  version: number;
}

/** The single call `mutate` makes: one event per committed state in the chain. */
export async function transitionNotifications(db: D1Database, t: TransitionInfo): Promise<D1PreparedStatement[]> {
  const out: D1PreparedStatement[] = [];
  for (let i = 1; i < t.chain.length; i++) {
    const kind = STATE_EVENT[t.chain[i]!];
    if (!kind) continue;
    const last = i === t.chain.length - 1;
    out.push(
      ...(await notifyStatements(db, {
        submissionId: t.sub.id, proposerId: t.sub.proposer_id, kind, actorId: t.actorId,
        refType: "review_state", refId: `${t.sub.id}:${t.version}:${t.chain[i]}`, at: t.at, version: t.version,
        payload: { register_id: t.sub.register_id, slug: t.sub.slug, from: t.chain[i - 1], to: t.chain[i], rev: t.rev, reason: last ? t.reason : null },
      })),
    );
  }
  return out;
}

export function renderEmail(n: { kind: string; payload: string; id: string; submission_id: string }): { subject: string; text: string } {
  const p = JSON.parse(n.payload) as Record<string, any>;
  const title = `${p.register_id ?? ""} ${p.slug ?? ""}`.trim();
  const lines = [`Event: ${n.kind}`];
  if (p.actor_name) lines.push(`By: ${p.actor_name}`);
  if (p.reason) lines.push(`Reason: ${p.reason}`);
  if (p.excerpt) lines.push(`Comment: ${p.excerpt}`);
  lines.push(`Open: /submissions/${n.submission_id}`, "", "Change what you receive under notification preferences.");
  return { subject: `[ITU OB] ${title}: ${n.kind}`, text: lines.join("\n") };
}
