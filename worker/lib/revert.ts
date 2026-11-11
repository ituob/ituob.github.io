// The revert path for a MERGED, unpublished submission (docs/submission-workflow.adoc
// "Withdrawal and the undo story"): a new PR that deletes the patch file. The submission
// becomes `withdrawn` only when that PR's merge arrives (github-webhook.ts applyRevertMerged,
// or the reconciler). Nothing here moves the state: the request is an audited, versioned
// no-history write through `mutate`.
import { auditStatements } from "./audit.ts";
import { requireRole } from "./authz.ts";
import { ConflictError, InvalidError } from "./membership.ts";
import { type PatchPublisher, branchName } from "./publisher.ts";
import { type Sub, getSub, mutate, run } from "./submissions.ts";
import type { Session } from "./types.ts";

export interface RevertOutcome {
  state: Sub["state"];
  attempt: number;
  pr_number: number | null;
  error: string | null;
}

const now = () => new Date().toISOString();
const rowOf = (db: D1Database, id: string) =>
  db.prepare(`SELECT * FROM submission_reverts WHERE submission_id=?1 ORDER BY attempt DESC LIMIT 1`).bind(id).first<any>();

/** Admin withdrawal of a `merged` submission: enqueue exactly one revert, then run the consumer. */
export async function requestRevert(db: D1Database, session: Session | null, id: string, b: Record<string, unknown>, publisher: PatchPublisher): Promise<RevertOutcome> {
  const s = requireRole(session, "itu-admin");
  const reason = typeof b.reason === "string" ? b.reason.trim() : "";
  if (!reason) throw new InvalidError("reason required");
  const sub = await getSub(db, id);
  if (sub.state === "published") throw new ConflictError("a published submission cannot be withdrawn; submit a correction (corrects_id)");
  if (sub.state !== "merged") throw new ConflictError(`illegal transition from ${sub.state}`);

  const last = await rowOf(db, id);
  // Idempotent: a revert that is still in flight is reused, never doubled.
  if (last && last.pr_state !== "closed") return openRevertFor(db, publisher, id);

  const pr = await db.prepare(`SELECT repo, path FROM submission_prs WHERE submission_id=?1 ORDER BY rev DESC LIMIT 1`).bind(id).first<{ repo: string; path: string }>();
  if (!pr || sub.target_edition === null || sub.seq === null) throw new ConflictError("no merged patch to revert");
  const attempt = (last?.attempt ?? 0) + 1;
  const branch = branchName(sub.target_edition, sub.seq, `${sub.slug}-revert${attempt}`, sub.id);
  const row = {
    submission_id: id, attempt, repo: pr.repo, branch, path: pr.path, idempotency_key: `revert:${pr.repo}:${branch}`,
    reason, requested_by: s.userId, created_at: now(),
  };
  await mutate(db, sub, {
    from: ["merged"], to: sub.state, noHistory: true, actor: { kind: "user", id: s.userId }, auditAction: "revert.requested",
    detail: { attempt, branch, path: pr.path, reason },
    extra: (d, v) => {
      const cols = Object.keys(row);
      return [
        d
          .prepare(`INSERT INTO submission_reverts (${cols.join(",")}) SELECT ${cols.map((_, i) => `?${i + 1}`).join(",")}
                     WHERE EXISTS (SELECT 1 FROM submissions WHERE id=?${cols.length + 1} AND version=?${cols.length + 2})`)
          .bind(...Object.values(row), id, v),
      ];
    },
  });
  return openRevertFor(db, publisher, id);
}

/** The idempotent consumer for `kind: revert`: opens the revert PR once. Safe to run any number of times. */
export async function openRevertFor(db: D1Database, publisher: PatchPublisher, id: string): Promise<RevertOutcome> {
  const sub = await getSub(db, id);
  const rv = await rowOf(db, id);
  if (!rv) throw new ConflictError("no revert requested");
  if (rv.pr_number !== null || rv.pr_state === "closed" || rv.pr_state === "merged")
    return { state: sub.state, attempt: rv.attempt, pr_number: rv.pr_number, error: null };
  if (sub.state !== "merged") return { state: sub.state, attempt: rv.attempt, pr_number: null, error: null };
  const t = now();
  try {
    const op = await publisher.openRevertPr({
      repo: rv.repo, branch: rv.branch, path: rv.path, idempotencyKey: rv.idempotency_key,
      title: `Revert OB-${sub.target_edition}: ${sub.action_type} ${sub.register_id}`,
      body: `Revert of submission ${sub.id}: deletes ${rv.path}. Reason: ${rv.reason}. A human merges.`,
    });
    await run(db, [
      db
        .prepare(`UPDATE submission_reverts SET pr_number=?3, pr_state='open', attempts=attempts+1, last_error=NULL WHERE submission_id=?1 AND attempt=?2 AND pr_number IS NULL`)
        .bind(id, rv.attempt, op.prNumber),
      ...(await auditStatements(db, [{
        at: t, actor_id: null, actor_kind: "system", action: "revert.opened", subject_type: "submission", subject_id: id, submission_id: id,
        detail: { pr_number: op.prNumber, branch: rv.branch, attempt: rv.attempt },
      }])),
    ]);
    return { state: sub.state, attempt: rv.attempt, pr_number: op.prNumber, error: null };
  } catch (e) {
    const msg = String((e as Error).message ?? e).slice(0, 300);
    await run(db, [
      db.prepare(`UPDATE submission_reverts SET attempts=attempts+1, last_error=?3 WHERE submission_id=?1 AND attempt=?2`).bind(id, rv.attempt, msg),
      ...(await auditStatements(db, [{
        at: t, actor_id: null, actor_kind: "system", action: "revert.failed", subject_type: "submission", subject_id: id, submission_id: id,
        detail: { error: msg, branch: rv.branch },
      }])),
    ]);
    return { state: sub.state, attempt: rv.attempt, pr_number: null, error: msg };
  }
}
