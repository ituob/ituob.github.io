// Per-submission discussion (#104): comments with immutable revisions and
// tombstones, @mentions, moderator close/reopen, history, inbox, prefs.
// Every write is one db.batch: domain rows + audit_log + notifications.
import { type AuditRow, auditStatements } from "./audit.ts";
import { Forbidden, hasRole, isItu } from "./authz.ts";
import { ConflictError, InvalidError, NotFoundError } from "./membership.ts";
import { notifyStatements, ituUsers, type Level } from "./notify.ts";
import { resolveAuthority } from "./authority.ts";
import { getSub, run, type Sub } from "./submissions.ts";
import type { Session } from "./types.ts";
import { ulid } from "./ulid.ts";

const now = () => new Date().toISOString();
export const MAX_BODY = 8000;
export const MAX_PER_HOUR = 60;
const MENTION_RE = /(?<![\w@])@([a-z0-9][a-z0-9._-]{2,31})/gi;
const HANDLE_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;

export function parseMentions(text: string): string[] {
  return [...new Set([...text.matchAll(MENTION_RE)].map((m) => m[1]!.replace(/\.+$/, "").toLowerCase()))];
}

function user(session: Session | null): Session {
  if (!session) throw new Forbidden();
  return session;
}

/** Involved parties: the proposer, any ITU role, and explicit participants. Others get 404 (no existence leak). */
export async function readableSub(db: D1Database, session: Session | null, id: string): Promise<{ s: Session; sub: Sub }> {
  const s = user(session);
  const sub = await getSub(db, id);
  if (sub.proposer_id === s.userId || isItu(s)) return { s, sub };
  const p = await db.prepare(`SELECT 1 AS x FROM submission_participants WHERE submission_id=?1 AND user_id=?2`).bind(id, s.userId).first();
  if (!p) throw new NotFoundError("unknown submission");
  return { s, sub };
}

async function canRead(db: D1Database, sub: Sub, userId: string): Promise<boolean> {
  if (sub.proposer_id === userId) return true;
  const a = await resolveAuthority(db, userId);
  if (a.roles.includes("itu-admin") || a.roles.includes("itu-editor")) return true;
  return !!(await db.prepare(`SELECT 1 AS x FROM submission_participants WHERE submission_id=?1 AND user_id=?2`).bind(sub.id, userId).first());
}

// ---------------------------------------------------------------- handles

export async function setHandle(db: D1Database, session: Session | null, handle: unknown) {
  const s = user(session);
  if (typeof handle !== "string" || !HANDLE_RE.test(handle.toLowerCase())) throw new InvalidError("handle must match [a-z0-9][a-z0-9._-]{2,31}");
  const h = handle.toLowerCase();
  const cur = await db.prepare(`SELECT handle, created_at FROM user_handles WHERE user_id=?1`).bind(s.userId).first<{ handle: string; created_at: string }>();
  if (cur?.handle === h) return { handle: h };
  const t = now();
  if (cur && Date.parse(cur.created_at) > Date.now() - 30 * 86_400_000) throw new ConflictError("handle can change once per 30 days");
  const taken = await db.prepare(`SELECT user_id FROM user_handles WHERE handle=?1 UNION SELECT user_id FROM handle_history WHERE handle=?1`).bind(h).first<{ user_id: string }>();
  if (taken && taken.user_id !== s.userId) throw new ConflictError("handle taken");
  await run(db, [
    ...(cur ? [
      db.prepare(`INSERT INTO handle_history (handle,user_id,retired_at) VALUES (?1,?2,?3) ON CONFLICT (handle) DO NOTHING`).bind(cur.handle, s.userId, t),
      db.prepare(`DELETE FROM user_handles WHERE user_id=?1`).bind(s.userId),
    ] : []),
    db.prepare(`INSERT INTO user_handles (user_id,handle,created_at) VALUES (?1,?2,?3)`).bind(s.userId, h, t),
  ]);
  return { handle: h };
}

async function resolveHandles(db: D1Database, handles: string[]): Promise<{ handle: string; user_id: string }[]> {
  const out: { handle: string; user_id: string }[] = [];
  for (const h of handles) {
    const r = await db.prepare(`SELECT user_id FROM user_handles WHERE handle=?1 UNION SELECT user_id FROM handle_history WHERE handle=?1`).bind(h).first<{ user_id: string }>();
    if (r) out.push({ handle: h, user_id: r.user_id }); // unresolved @text stays plain text
  }
  return out;
}

// ---------------------------------------------------------------- comments

interface Anchor { rev: number | null; path: string | null; line: number | null; quote: string | null }
function parseAnchor(a: unknown, sub: Sub): Anchor {
  if (a === undefined || a === null) return { rev: null, path: null, line: null, quote: null };
  if (typeof a !== "object" || Array.isArray(a)) throw new InvalidError("anchor must be an object");
  const o = a as Record<string, unknown>;
  const rev = o.rev === undefined ? sub.current_rev : o.rev;
  if (!Number.isInteger(rev) || (rev as number) < 1 || (rev as number) > sub.current_rev) throw new InvalidError("anchor.rev out of range");
  const path = o.path ?? null, quote = o.quote ?? null, line = o.line ?? null;
  if (path !== null && (typeof path !== "string" || path.length > 200)) throw new InvalidError("anchor.path invalid");
  if (quote !== null && (typeof quote !== "string" || quote.length > 500)) throw new InvalidError("anchor.quote invalid");
  if (line !== null && (!Number.isInteger(line) || (line as number) < 1)) throw new InvalidError("anchor.line invalid");
  if (path === null && line === null) throw new InvalidError("anchor needs path or line");
  return { rev: rev as number, path: path as string | null, line: line as number | null, quote: quote as string | null };
}

function cleanBody(b: unknown): string {
  if (typeof b !== "string" || b.trim().length === 0) throw new InvalidError("body required");
  if (b.length > MAX_BODY) throw new InvalidError(`body over ${MAX_BODY} characters`);
  return b;
}

function openFor(sub: Sub, s: Session) {
  if (sub.discussion_closed && !isItu(s)) throw new ConflictError("discussion is closed");
}

async function mentionTargets(db: D1Database, sub: Sub, text: string) {
  const resolved = await resolveHandles(db, parseMentions(text));
  const refused: string[] = [];
  const ok: { handle: string; user_id: string }[] = [];
  for (const m of resolved) (await canRead(db, sub, m.user_id)) ? ok.push(m) : refused.push(m.handle);
  if (refused.length) throw new InvalidError(`cannot mention users without access: ${refused.join(", ")}`);
  return ok;
}

async function actorName(db: D1Database, id: string): Promise<string> {
  const r = await db.prepare(`SELECT COALESCE(display_name, email, id) AS n FROM users WHERE id=?1`).bind(id).first<{ n: string }>();
  return r?.n ?? id;
}

/** Notification fan-out for a comment revision: mention > reply > created, one row per user. */
async function commentNotifications(
  db: D1Database, sub: Sub, s: Session, commentId: string, parentAuthor: string | null,
  mentions: { user_id: string }[], text: string, at: string, includeCreated: boolean,
) {
  const base = {
    submissionId: sub.id, proposerId: sub.proposer_id, actorId: s.userId, refType: "comment", refId: commentId, at,
  };
  const name = await actorName(db, s.userId);
  const payload = { register_id: sub.register_id, slug: sub.slug, actor_name: name, excerpt: text.slice(0, 280) };
  const mentioned = new Set(mentions.map((m) => m.user_id));
  const out: D1PreparedStatement[] = [];
  out.push(...(await notifyStatements(db, { ...base, kind: "comment.mention", payload }, [...mentioned])));
  if (!includeCreated) return out;
  const reply = parentAuthor && !mentioned.has(parentAuthor) ? [parentAuthor] : [];
  out.push(...(await notifyStatements(db, { ...base, kind: "comment.reply", payload }, reply)));
  const part = (await db.prepare(`SELECT DISTINCT user_id FROM submission_participants WHERE submission_id=?1 AND role IN ('contact','watcher')`).bind(sub.id).all<{ user_id: string }>()).results.map((r) => r.user_id);
  const all = [sub.proposer_id, ...part, ...(await ituUsers(db, false, true))].filter((u) => !mentioned.has(u) && !reply.includes(u));
  out.push(...(await notifyStatements(db, { ...base, kind: "comment.created", payload }, all)));
  return out;
}

export async function addComment(db: D1Database, session: Session | null, submissionId: string, b: Record<string, unknown>) {
  const { s, sub } = await readableSub(db, session, submissionId);
  openFor(sub, s);
  const text = cleanBody(b.body);
  const anchor = parseAnchor(b.anchor, sub);
  const recent = await db.prepare(`SELECT count(*) AS n FROM comments WHERE author_id=?1 AND created_at > ?2`).bind(s.userId, new Date(Date.now() - 3_600_000).toISOString()).first<{ n: number }>();
  if (recent!.n >= MAX_PER_HOUR) throw new InvalidError("comment rate limit exceeded");

  let parentId: string | null = null, rootId: string | null = null, parentAuthor: string | null = null;
  if (typeof b.parent_id === "string") {
    const p = await db.prepare(`SELECT id, root_id, author_id, submission_id, deleted_at FROM comments WHERE id=?1`).bind(b.parent_id).first<any>();
    if (!p || p.submission_id !== sub.id) throw new InvalidError("unknown parent comment");
    parentId = p.id; rootId = p.root_id; parentAuthor = p.author_id; // two levels: replies flatten to the root
  }
  const mentions = await mentionTargets(db, sub, text);
  const id = ulid();
  const t = now();
  const kind = isItu(s) ? "itu" : "member";
  const memberId = kind === "member" ? s.memberStateId : null;
  const audit: AuditRow = {
    at: t, actor_id: s.userId, actor_kind: "user", action: "comment.created", subject_type: "comment", subject_id: id,
    submission_id: sub.id, detail: { rev: 1, parent_id: parentId, mentions: mentions.map((m) => m.user_id) },
  };
  const stmts = [
    db.prepare(`INSERT INTO comments (id,submission_id,parent_id,root_id,author_id,affiliation_kind,affiliation_member_id,anchor_rev,anchor_path,anchor_line,anchor_quote,created_at)
                VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`)
      .bind(id, sub.id, parentId, rootId ?? id, s.userId, kind, memberId, anchor.rev, anchor.path, anchor.line, anchor.quote, t),
    db.prepare(`INSERT INTO comment_revisions (comment_id,rev,body,mentions,edited_by,created_at) VALUES (?1,1,?2,?3,?4,?5)`)
      .bind(id, text, JSON.stringify(mentions), s.userId, t),
    ...(await participantRows(db, sub, mentions, s.userId, t)),
    ...(await auditStatements(db, [audit])),
    ...(await commentNotifications(db, sub, s, id, parentAuthor, mentions, text, t, true)),
  ];
  await run(db, stmts);
  return getComment(db, id);
}

/** A mentioned ITU user who is not yet involved becomes a `mentioned` participant. */
async function participantRows(db: D1Database, sub: Sub, mentions: { user_id: string }[], by: string, t: string) {
  return mentions
    .filter((m) => m.user_id !== sub.proposer_id)
    .map((m) => db.prepare(`INSERT INTO submission_participants (submission_id,user_id,role,added_by,added_at) VALUES (?1,?2,'mentioned',?3,?4) ON CONFLICT DO NOTHING`).bind(sub.id, m.user_id, by, t));
}

export async function editComment(db: D1Database, session: Session | null, submissionId: string, commentId: string, b: Record<string, unknown>) {
  const { s, sub } = await readableSub(db, session, submissionId);
  const c = await rawComment(db, sub.id, commentId);
  if (c.kind !== "comment" || c.author_id !== s.userId) throw new Forbidden(); // a moderator cannot rewrite someone else's text
  if (c.deleted_at) throw new ConflictError("comment is deleted");
  openFor(sub, s);
  const text = cleanBody(b.body);
  const mentions = await mentionTargets(db, sub, text);
  const rev = c.current_rev + 1;
  const t = now();
  const stmts = [
    db.prepare(`INSERT INTO comment_revisions (comment_id,rev,body,mentions,edited_by,created_at)
                SELECT ?1,?2,?3,?4,?5,?6 WHERE EXISTS (SELECT 1 FROM comments WHERE id=?1 AND current_rev=?7 AND deleted_at IS NULL)`)
      .bind(commentId, rev, text, JSON.stringify(mentions), s.userId, t, c.current_rev),
    db.prepare(`UPDATE comments SET current_rev=?2 WHERE id=?1 AND current_rev=?3 AND deleted_at IS NULL`).bind(commentId, rev, c.current_rev),
    ...(await participantRows(db, sub, mentions, s.userId, t)),
    ...(await auditStatements(db, [{
      at: t, actor_id: s.userId, actor_kind: "user", action: "comment.revised", subject_type: "comment", subject_id: commentId,
      submission_id: sub.id, detail: { rev, mentions: mentions.map((m) => m.user_id) },
    }])),
    // dedupe_key (kind:comment:user) means only NEWLY mentioned users get a row.
    ...(await commentNotifications(db, sub, s, commentId, null, mentions, text, t, false)),
  ];
  await run(db, stmts);
  return getComment(db, commentId);
}

/** Tombstone: nothing is erased. Author or ITU moderator; a moderator delete needs a reason. */
export async function deleteComment(db: D1Database, session: Session | null, submissionId: string, commentId: string, b: Record<string, unknown>, moderator: boolean) {
  const { s, sub } = await readableSub(db, session, submissionId);
  const c = await rawComment(db, sub.id, commentId);
  if (c.kind !== "comment") throw new Forbidden();
  if (c.deleted_at) throw new ConflictError("already deleted");
  const own = c.author_id === s.userId;
  const reason = typeof b.reason === "string" && b.reason.trim() ? b.reason.trim() : null;
  if (moderator) {
    if (!isItu(s)) throw new Forbidden();
    if (!reason) throw new InvalidError("reason required");
  } else if (!own) throw new Forbidden();
  const t = now();
  const res = await run(db, [
    db.prepare(`UPDATE comments SET deleted_at=?2, deleted_by=?3, delete_reason=?4 WHERE id=?1 AND deleted_at IS NULL`).bind(commentId, t, s.userId, reason),
    ...(await auditStatements(db, [{
      at: t, actor_id: s.userId, actor_kind: "user", action: "comment.deleted", subject_type: "comment", subject_id: commentId,
      submission_id: sub.id, detail: { by: moderator && !own ? "moderator" : "author", reason },
    }], { sql: "EXISTS (SELECT 1 FROM comments WHERE id = ?G1 AND deleted_at = ?G2)", args: [commentId, t] })),
  ]);
  if (res[0]?.meta.changes !== 1) throw new ConflictError("comment changed concurrently");
  return getComment(db, commentId);
}

export async function restoreComment(db: D1Database, session: Session | null, submissionId: string, commentId: string, b: Record<string, unknown>) {
  const { s, sub } = await readableSub(db, session, submissionId);
  if (!isItu(s)) throw new Forbidden();
  const c = await rawComment(db, sub.id, commentId);
  if (!c.deleted_at) throw new ConflictError("not deleted");
  const reason = typeof b.reason === "string" && b.reason.trim() ? b.reason.trim() : null;
  if (!reason) throw new InvalidError("reason required");
  const t = now();
  await run(db, [
    db.prepare(`UPDATE comments SET deleted_at=NULL, deleted_by=NULL, delete_reason=NULL WHERE id=?1 AND deleted_at IS NOT NULL`).bind(commentId),
    ...(await auditStatements(db, [{
      at: t, actor_id: s.userId, actor_kind: "user", action: "comment.restored", subject_type: "comment", subject_id: commentId,
      submission_id: sub.id, detail: { reason, was_deleted_at: c.deleted_at, was_deleted_by: c.deleted_by, was_reason: c.delete_reason },
    }])),
  ]);
  return getComment(db, commentId);
}

async function rawComment(db: D1Database, submissionId: string, id: string): Promise<any> {
  const c = await db.prepare(`SELECT * FROM comments WHERE id=?1 AND submission_id=?2`).bind(id, submissionId).first<any>();
  if (!c) throw new NotFoundError("unknown comment");
  return c;
}
async function getComment(db: D1Database, id: string) {
  return db.prepare(`SELECT c.*, r.body, r.mentions FROM comments c JOIN comment_revisions r ON r.comment_id=c.id AND r.rev=c.current_rev WHERE c.id=?1`).bind(id).first();
}

/** Thread view: tombstoned bodies are hidden except from itu-admin; history (below) keeps them for all involved parties. */
export async function readThread(db: D1Database, session: Session | null, submissionId: string) {
  const { s, sub } = await readableSub(db, session, submissionId);
  const rows = (await db.prepare(`SELECT * FROM comments WHERE submission_id=?1 ORDER BY created_at, id`).bind(sub.id).all<any>()).results;
  const revs = (await db.prepare(`SELECT r.* FROM comment_revisions r JOIN comments c ON c.id=r.comment_id WHERE c.submission_id=?1 ORDER BY r.comment_id, r.rev`).bind(sub.id).all<any>()).results;
  const admin = hasRole(s, "itu-admin");
  return {
    discussion_closed: !!sub.discussion_closed,
    comments: rows.map((c) => {
      const hide = c.deleted_at && !admin;
      return { ...c, revisions: hide ? [] : revs.filter((r) => r.comment_id === c.id) };
    }),
  };
}

/** Complete history for any involved party: all comments with every revision and tombstone, transitions, discussion log, the caller's own notifications. */
export async function readHistory(db: D1Database, session: Session | null, submissionId: string) {
  const { s, sub } = await readableSub(db, session, submissionId);
  const comments = (await db.prepare(`SELECT * FROM comments WHERE submission_id=?1 ORDER BY created_at, id`).bind(sub.id).all<any>()).results;
  const revisions = (await db.prepare(`SELECT r.* FROM comment_revisions r JOIN comments c ON c.id=r.comment_id WHERE c.submission_id=?1 ORDER BY r.comment_id, r.rev`).bind(sub.id).all()).results;
  const transitions = (await db.prepare(`SELECT from_state,to_state,actor_id,actor_kind,reason,rev,at FROM review_state WHERE submission_id=?1 ORDER BY id`).bind(sub.id).all()).results;
  const discussion = (await db.prepare(`SELECT closed,actor_id,reason,at FROM discussion_state_log WHERE submission_id=?1 ORDER BY id`).bind(sub.id).all()).results;
  const notifications = (await db.prepare(`SELECT id,kind,ref_type,ref_id,payload,read_at,created_at,email_status,email_reason FROM notifications WHERE submission_id=?1 AND user_id=?2 ORDER BY created_at, id`).bind(sub.id, s.userId).all()).results;
  const audit = hasRole(s, "itu-admin")
    ? (await db.prepare(`SELECT id,at,actor_id,action,subject_type,subject_id,detail FROM audit_log WHERE submission_id=?1 ORDER BY id`).bind(sub.id).all()).results
    : undefined;
  return { comments, revisions, transitions, discussion, notifications, audit };
}

// ---------------------------------------------------------------- moderation

export async function setDiscussionClosed(db: D1Database, session: Session | null, submissionId: string, closed: boolean, b: Record<string, unknown>) {
  const { s, sub } = await readableSub(db, session, submissionId);
  if (!isItu(s)) throw new Forbidden();
  if (sub.proposer_id === s.userId && !hasRole(s, "itu-admin")) throw new Forbidden(); // no moderating your own submission
  const reason = typeof b.reason === "string" && b.reason.trim() ? b.reason.trim() : null;
  if (!reason) throw new InvalidError("reason required");
  if (!!sub.discussion_closed === closed) throw new ConflictError(closed ? "already closed" : "already open");
  const t = now();
  const kind = closed ? "discussion.closed" : "discussion.reopened";
  const res = await run(db, [
    db.prepare(`UPDATE submissions SET discussion_closed=?2 WHERE id=?1 AND discussion_closed=?3`).bind(sub.id, closed ? 1 : 0, closed ? 0 : 1),
    db.prepare(`INSERT INTO discussion_state_log (submission_id,closed,actor_id,reason,at) VALUES (?1,?2,?3,?4,?5)`).bind(sub.id, closed ? 1 : 0, s.userId, reason, t),
    ...(await auditStatements(db, [{
      at: t, actor_id: s.userId, actor_kind: "user", action: kind, subject_type: "submission", subject_id: sub.id,
      submission_id: sub.id, detail: { reason },
    }])),
    ...(await notifyStatements(db, {
      submissionId: sub.id, proposerId: sub.proposer_id, kind, actorId: s.userId, refType: "discussion_state_log",
      refId: `${sub.id}:${t}`, at: t, payload: { register_id: sub.register_id, slug: sub.slug, reason, actor_name: await actorName(db, s.userId) },
    })),
  ]);
  if (res[0]?.meta.changes !== 1) throw new ConflictError("discussion state changed concurrently");
  return { discussion_closed: closed };
}

export async function addParticipant(db: D1Database, session: Session | null, submissionId: string, b: Record<string, unknown>) {
  const { s, sub } = await readableSub(db, session, submissionId);
  if (!isItu(s)) throw new Forbidden();
  const userId = b.userId, role = b.role;
  if (typeof userId !== "string" || (role !== "contact" && role !== "watcher")) throw new InvalidError("userId and role (contact|watcher) required");
  const u = await db.prepare(`SELECT 1 AS x FROM users WHERE id=?1`).bind(userId).first();
  if (!u) throw new InvalidError("no account for this user"); // D5: no email to people without an account
  const t = now();
  await run(db, [
    db.prepare(`INSERT INTO submission_participants (submission_id,user_id,role,added_by,added_at) VALUES (?1,?2,?3,?4,?5) ON CONFLICT DO NOTHING`).bind(sub.id, userId, role, s.userId, t),
    // suggested default for rows created by someone else: mentions; never overrides a choice
    db.prepare(`INSERT INTO notification_prefs (user_id,level,updated_at) VALUES (?1,'mentions',?2) ON CONFLICT DO NOTHING`).bind(userId, t),
    ...(await auditStatements(db, [{
      at: t, actor_id: s.userId, actor_kind: "user", action: "participant.added", subject_type: "submission", subject_id: sub.id,
      submission_id: sub.id, detail: { user_id: userId, role },
    }])),
  ]);
  return { user_id: userId, role };
}

// ---------------------------------------------------------------- inbox + prefs

export async function listNotifications(db: D1Database, session: Session | null, unreadOnly: boolean) {
  const s = user(session);
  return (await db.prepare(`SELECT id,submission_id,kind,payload,read_at,created_at,email_status,email_reason FROM notifications WHERE user_id=?1 ${unreadOnly ? "AND read_at IS NULL" : ""} ORDER BY created_at DESC, id DESC LIMIT 200`).bind(s.userId).all()).results;
}

export async function markRead(db: D1Database, session: Session | null, id: string) {
  const s = user(session);
  const r = await db.prepare(`UPDATE notifications SET read_at=COALESCE(read_at,?3) WHERE id=?1 AND user_id=?2`).bind(id, s.userId, now()).run();
  if (r.meta.changes !== 1) throw new NotFoundError("unknown notification");
}

export async function setPrefs(db: D1Database, session: Session | null, level: unknown): Promise<{ level: Level }> {
  const s = user(session);
  if (level !== "all" && level !== "mentions" && level !== "none") throw new InvalidError("level must be all, mentions or none");
  const t = now();
  const old = await db.prepare(`SELECT level FROM notification_prefs WHERE user_id=?1`).bind(s.userId).first<{ level: string }>();
  await run(db, [
    db.prepare(`INSERT INTO notification_prefs (user_id,level,updated_at) VALUES (?1,?2,?3) ON CONFLICT (user_id) DO UPDATE SET level=?2, updated_at=?3`).bind(s.userId, level, t),
    ...(await auditStatements(db, [{
      at: t, actor_id: s.userId, actor_kind: "user", action: "prefs.changed", subject_type: "user", subject_id: s.userId,
      submission_id: null, detail: { from: old?.level ?? "all", to: level },
    }])),
  ]);
  return { level };
}
