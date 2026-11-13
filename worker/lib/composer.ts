// The admin composer (docs/submission-workflow.adoc "PR merged -> composer -> issue publication").
// The ONLY module that moves a submission to `scheduled` or `published`, and (besides the signature-
// verified webhook path) back to `merged` when an admin takes an item out of an edition. Every move
// goes through `mutate`. All entry points require itu-admin; the routes are Access-guarded and no
// member endpoint imports this file (source guards in test/submissions.test.ts).
import { auditStatements } from "./audit.ts";
import { requireRole } from "./authz.ts";
import { ConflictError, InvalidError, NotFoundError } from "./membership.ts";
import { type PatchPublisher } from "./publisher.ts";
import { type Sub, UpstreamError, getSub, mutate, run } from "./submissions.ts";
import type { Session } from "./types.ts";

export interface Edition {
  ob_issue_no: number;
  status: "open" | "composing" | "staged" | "published";
  freeze_sha: string | null;
  meta_pr: number | null;
  staging_commit: string | null;
  published_at: string | null;
  created_at: string;
}

const now = () => new Date().toISOString();
const admin = (s: Session | null): Session => requireRole(s, "itu-admin");

export function editionNo(v: unknown): number {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 99999) throw new InvalidError("ob_issue_no must be a positive integer");
  return n;
}

export async function getEdition(db: D1Database, no: number): Promise<Edition> {
  const e = await db.prepare(`SELECT * FROM editions WHERE ob_issue_no=?1`).bind(no).first<Edition>();
  if (!e) throw new NotFoundError("unknown edition");
  return e;
}

/**
 * A statement that fails the whole batch (NOT NULL on `position`) unless the edition is in one of
 * `statuses`. A conditional write that silently matches nothing would leave the submission moved
 * without its edition row; a violated constraint rolls the batch back instead.
 */
const requireEditionStatus = (db: D1Database, no: number, statuses: Edition["status"][]) =>
  db
    .prepare(
      `INSERT INTO edition_items (ob_issue_no, submission_id, position)
       SELECT ?1, '-', NULL WHERE NOT EXISTS (SELECT 1 FROM editions WHERE ob_issue_no=?1 AND status IN (${statuses.map((s) => `'${s}'`).join(",")}))`,
    )
    .bind(no);

const auditEdition = (at: string, userId: string, no: number, action: string, detail: Record<string, unknown>) =>
  ({ at, actor_id: userId, actor_kind: "user" as const, action, subject_type: "edition" as const, subject_id: String(no), submission_id: null, detail });

// ---------------------------------------------------------------- reads

/** Merged, not yet published: the composer's work list. `edition` is where it is placed, if anywhere. */
export async function listMergedUnpublished(db: D1Database, session: Session | null) {
  admin(session);
  return (
    await db
      .prepare(
        `SELECT s.id, s.register_id, s.slug, s.action_type, s.state, s.target_edition, s.seq, s.current_rev,
                p.path, p.pr_number, p.merge_sha, i.ob_issue_no AS edition, i.position,
                (SELECT pr_state FROM submission_reverts r WHERE r.submission_id=s.id ORDER BY attempt DESC LIMIT 1) AS revert_state
           FROM submissions s
           LEFT JOIN submission_prs p ON p.submission_id=s.id AND p.rev=(SELECT max(rev) FROM submission_prs WHERE submission_id=s.id)
           LEFT JOIN edition_items i ON i.submission_id=s.id
          WHERE s.state IN ('merged','scheduled')
          ORDER BY s.target_edition, s.seq, s.id`,
      )
      .all()
  ).results;
}

export async function listEditions(db: D1Database, session: Session | null) {
  admin(session);
  return (await db.prepare(`SELECT * FROM editions ORDER BY ob_issue_no DESC`).all<Edition>()).results;
}

export async function readEdition(db: D1Database, session: Session | null, no: number) {
  admin(session);
  const edition = await getEdition(db, no);
  const items = (
    await db
      .prepare(
        `SELECT i.position, s.id AS submission_id, s.state, s.slug, s.action_type, s.seq, p.path, p.merge_sha
           FROM edition_items i JOIN submissions s ON s.id=i.submission_id
           LEFT JOIN submission_prs p ON p.submission_id=s.id AND p.rev=(SELECT max(rev) FROM submission_prs WHERE submission_id=s.id)
          WHERE i.ob_issue_no=?1 ORDER BY i.position`,
      )
      .bind(no)
      .all()
  ).results;
  return { edition, items };
}

// ---------------------------------------------------------------- editions

/** Create edition `no` (status open) or return it. At most one edition is open at a time. */
export async function openEdition(db: D1Database, session: Session | null, no: number): Promise<{ edition: Edition; created: boolean }> {
  const s = admin(session);
  const have = await db.prepare(`SELECT * FROM editions WHERE ob_issue_no=?1`).bind(no).first<Edition>();
  if (have) return { edition: have, created: false };
  const open = await db.prepare(`SELECT ob_issue_no FROM editions WHERE status='open'`).first<{ ob_issue_no: number }>();
  if (open) throw new ConflictError(`edition ${open.ob_issue_no} is already open`);
  const t = now();
  await run(db, [
    db.prepare(`INSERT INTO editions (ob_issue_no,status,created_at) VALUES (?1,'open',?2)`).bind(no, t),
    ...(await auditStatements(db, [auditEdition(t, s.userId, no, "edition.created", { status: "open" })])),
  ]);
  return { edition: await getEdition(db, no), created: true };
}

// ---------------------------------------------------------------- placement

/** merged -> scheduled: place a merged submission in its target edition (edition_items row, same batch). */
export async function placeItem(db: D1Database, session: Session | null, no: number, submissionId: string): Promise<Sub> {
  const s = admin(session);
  const ed = await getEdition(db, no);
  if (ed.status !== "open" && ed.status !== "composing") throw new ConflictError(`edition ${no} is ${ed.status}`);
  const sub = await getSub(db, submissionId);
  if (sub.state !== "merged") throw new ConflictError(`illegal transition from ${sub.state}`);
  if (sub.target_edition !== no) throw new ConflictError(`submission targets edition ${sub.target_edition}, not ${no}`);
  const rv = await db.prepare(`SELECT pr_state FROM submission_reverts WHERE submission_id=?1 ORDER BY attempt DESC LIMIT 1`).bind(sub.id).first<{ pr_state: string | null }>();
  if (rv && rv.pr_state !== "closed") throw new ConflictError("a revert is pending for this submission");
  if (ed.status === "open") {
    const active = await db.prepare(`SELECT ob_issue_no FROM editions WHERE status IN ('composing','staged')`).first<{ ob_issue_no: number }>();
    if (active) throw new ConflictError(`edition ${active.ob_issue_no} is already being composed`);
  }
  return mutate(db, sub, {
    from: ["merged"], to: "scheduled", actor: { kind: "user", id: s.userId }, auditAction: "composer.placed",
    detail: { edition: no },
    extra: (d, v) => [
      requireEditionStatus(d, no, ["open", "composing"]),
      d
        .prepare(
          `INSERT INTO edition_items (ob_issue_no, submission_id, position)
           SELECT ?1, ?2, COALESCE(MAX(position), 0) + 1 FROM edition_items WHERE ob_issue_no=?1
            AND EXISTS (SELECT 1 FROM submissions WHERE id=?2 AND version=?3)`,
        )
        .bind(no, sub.id, v),
      d.prepare(`UPDATE editions SET status='composing' WHERE ob_issue_no=?1 AND status='open'`).bind(no),
    ],
  });
}

/** scheduled -> merged: take an item out of an edition that has not been staged. */
export async function removeItem(db: D1Database, session: Session | null, no: number, submissionId: string): Promise<Sub> {
  const s = admin(session);
  const ed = await getEdition(db, no);
  if (ed.status !== "composing") throw new ConflictError(`edition ${no} is ${ed.status}`);
  const sub = await getSub(db, submissionId);
  if (sub.state !== "scheduled") throw new ConflictError(`illegal transition from ${sub.state}`);
  const item = await db.prepare(`SELECT 1 AS x FROM edition_items WHERE ob_issue_no=?1 AND submission_id=?2`).bind(no, sub.id).first();
  if (!item) throw new ConflictError("submission is not in this edition");
  return mutate(db, sub, {
    from: ["scheduled"], to: "merged", actor: { kind: "user", id: s.userId }, auditAction: "composer.removed",
    detail: { edition: no },
    extra: (d, v) => [
      requireEditionStatus(d, no, ["composing"]),
      d
        .prepare(`DELETE FROM edition_items WHERE ob_issue_no=?1 AND submission_id=?2 AND EXISTS (SELECT 1 FROM submissions WHERE id=?2 AND version=?3)`)
        .bind(no, sub.id, v),
      // An edition emptied by removals must not keep holding the single composing slot:
      // it goes back to `open`, or, when another edition is already open, the empty row goes.
      d
        .prepare(
          `UPDATE editions SET status='open' WHERE ob_issue_no=?1 AND status='composing'
            AND NOT EXISTS (SELECT 1 FROM edition_items WHERE ob_issue_no=?1)
            AND NOT EXISTS (SELECT 1 FROM editions WHERE status='open')`,
        )
        .bind(no),
      d
        .prepare(`DELETE FROM editions WHERE ob_issue_no=?1 AND status='composing' AND NOT EXISTS (SELECT 1 FROM edition_items WHERE ob_issue_no=?1)`)
        .bind(no),
    ],
  });
}

// ---------------------------------------------------------------- publication

/**
 * Publish an edition: a pin bump behind the publisher, then scheduled -> published for every item.
 * Pending pin PRs/deployments leave the edition composing and every item scheduled.
 * Resumable: only a confirmed bump stages the edition (with freeze_sha); a failure midway
 * is repaired by calling this again. Already published items are skipped; the bump is idempotent.
 */
export async function publishEdition(db: D1Database, session: Session | null, no: number, publisher: PatchPublisher) {
  const s = admin(session);
  let ed = await getEdition(db, no);
  if (ed.status === "published") throw new ConflictError(`edition ${no} is already published`);
  if (ed.status === "open") throw new ConflictError(`edition ${no} has nothing placed`);
  const itemQuery = `SELECT i.submission_id, i.position, s.state, p.merge_sha FROM edition_items i JOIN submissions s ON s.id=i.submission_id
    LEFT JOIN submission_prs p ON p.submission_id=s.id AND p.rev=(SELECT max(rev) FROM submission_prs WHERE submission_id=s.id)
    WHERE i.ob_issue_no=?1 ORDER BY i.position`;
  const items = (await db.prepare(itemQuery).bind(no)
    .all<{ submission_id: string; position: number; state: string; merge_sha: string | null }>()).results;
  if (items.length === 0) throw new ConflictError(`edition ${no} has nothing placed`);
  const bad = items.find((i) => i.state !== "scheduled" && i.state !== "published");
  if (bad) throw new ConflictError(`item ${bad.submission_id} is ${bad.state}, not scheduled`);

  if (ed.status === "composing") {
    let bump;
    try {
      bump = await publisher.bumpDataPin({
        edition: no, idempotencyKey: `edition-${no}-pin`,
        items: items.map((i) => ({ submissionId: i.submission_id, mergeSha: i.merge_sha })),
      });
    } catch (e) {
      throw new UpstreamError(`could not bump the data pin: ${String((e as Error).message)}`);
    }
    if (bump.pending) return { edition: ed, published: [], pending: bump.pending };
    const t = now();
    await run(db, [
      // Check the selected snapshot in the SAME transaction as staging. Placement may have
      // changed during the upstream request; publishing that stale pin must roll back.
      db.prepare(`INSERT INTO edition_items (ob_issue_no, submission_id, position)
        SELECT ?1, '-', NULL WHERE (SELECT count(*) FROM edition_items WHERE ob_issue_no=?1) != ?3
          OR EXISTS (SELECT 1 FROM json_each(?2) expected WHERE NOT EXISTS (
            SELECT 1 FROM (${itemQuery}) current
              WHERE current.submission_id=json_extract(expected.value, '$.submission_id')
                AND current.position=json_extract(expected.value, '$.position')
                AND current.state=json_extract(expected.value, '$.state')
                AND current.merge_sha IS json_extract(expected.value, '$.merge_sha')
          ))`).bind(no, JSON.stringify(items), items.length),
      db.prepare(`UPDATE editions SET status='staged', freeze_sha=?2, staging_commit=?3 WHERE ob_issue_no=?1 AND status='composing'`).bind(no, bump.freezeSha, bump.siteCommit),
      requireEditionStatusAfter(db, no),
      ...(await auditStatements(db, [auditEdition(t, s.userId, no, "edition.staged", { freeze_sha: bump.freezeSha, staging_commit: bump.siteCommit })])),
    ]);
    ed = await getEdition(db, no);
  }

  const published: string[] = [];
  for (const i of items) {
    if (i.state === "published") continue;
    const sub = await getSub(db, i.submission_id);
    await mutate(db, sub, {
      from: ["scheduled"], to: "published", actor: { kind: "user", id: s.userId }, auditAction: "composer.published",
      detail: { edition: no, freeze_sha: ed.freeze_sha },
      extra: (d) => [requireEditionStatus(d, no, ["staged"])],
    });
    published.push(i.submission_id);
  }
  const t = now();
  await run(db, [
    db.prepare(`UPDATE editions SET status='published', published_at=?2 WHERE ob_issue_no=?1 AND status='staged'`).bind(no, t),
    ...(await auditStatements(db, [auditEdition(t, s.userId, no, "edition.published", { published, freeze_sha: ed.freeze_sha })])),
  ]);
  return { edition: await getEdition(db, no), published };
}

/** Fails the batch unless the edition is now `staged` (the UPDATE just before it matched). */
const requireEditionStatusAfter = (db: D1Database, no: number) => requireEditionStatus(db, no, ["staged"]);
