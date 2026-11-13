// Repairs a lost webhook (docs/submission-workflow.adoc "Idempotency and retry": a scheduled
// reconciler compares GitHub with D1). It asks the publisher for the state of every PR whose
// outcome we are waiting for and applies the SAME guarded transitions the webhook does
// (github-webhook.ts apply*), so a late webhook after a repair is a no-op, and running this twice
// changes nothing the second time. A PR whose state cannot be read is skipped and reported.
import { ConflictError } from "./membership.ts";
import { type PatchPublisher } from "./publisher.ts";
import { type PrRow, type RevertRow, applyPrClosed, applyPrMerged, applyRevertClosed, applyRevertMerged } from "./github-webhook.ts";
import { openRevertFor } from "./revert.ts";
import { getSub } from "./submissions.ts";

export interface ReconcileReport {
  checked: number;
  /** `from`/`to` are present only when the repair moved the submission; opening a revert PR moves nothing. */
  repaired: { submission_id: string; kind: string; from?: string; to?: string }[];
  errors: { submission_id: string; error: string }[];
}

export async function reconcile(db: D1Database, publisher: PatchPublisher): Promise<ReconcileReport> {
  const report: ReconcileReport = { checked: 0, repaired: [], errors: [] };
  const fail = (id: string, e: unknown) => report.errors.push({ submission_id: id, error: String((e as Error).message ?? e).slice(0, 300) });

  // 1. Patch PRs we are waiting on (the newest revision's PR, state pr_open or ci_failed).
  const prs = (
    await db
      .prepare(
        `SELECT p.* FROM submission_prs p JOIN submissions s ON s.id=p.submission_id
          WHERE s.state IN ('pr_open','ci_failed') AND p.pr_number IS NOT NULL
            AND p.rev=(SELECT max(rev) FROM submission_prs WHERE submission_id=p.submission_id)
          ORDER BY p.submission_id`,
      )
      .all<PrRow>()
  ).results;
  for (const pr of prs) {
    report.checked++;
    try {
      // The persisted commit is the head that was approved. A later push to the same
      // branch must not be allowed to repair the submission as though it were approved.
      const gh = await publisher.getPullRequest({ repo: pr.repo, prNumber: pr.pr_number!, expectedHeadSha: pr.commit_sha ?? "" });
      if (gh.state === "open") continue;
      const sub = await getSub(db, pr.submission_id);
      const input = { number: pr.pr_number!, mergeSha: gh.mergeSha, baseRef: gh.baseRef, d: null };
      const r = gh.merged ? await applyPrMerged(db, pr, sub, input) : await applyPrClosed(db, pr, sub, input);
      if (r.kind === "applied") report.repaired.push({ submission_id: sub.id, kind: gh.merged ? "pr.merged" : "pr.closed", from: r.from, to: r.to });
    } catch (e) {
      // A concurrent webhook already applied it: the repair is moot, not an error.
      if (!(e instanceof ConflictError)) fail(pr.submission_id, e);
    }
  }

  // 2. Revert PRs we are waiting on (submission still `merged`).
  const reverts = (
    await db
      .prepare(
        `SELECT r.* FROM submission_reverts r JOIN submissions s ON s.id=r.submission_id
          WHERE s.state='merged' AND r.attempt=(SELECT max(attempt) FROM submission_reverts WHERE submission_id=r.submission_id)
            AND (r.pr_state IS NULL OR r.pr_state='open')
          ORDER BY r.submission_id`,
      )
      .all<RevertRow>()
  ).results;
  for (const rv of reverts) {
    report.checked++;
    try {
      if (rv.pr_number === null) {
        // The consumer never finished opening it: finish (idempotent by key).
        const o = await openRevertFor(db, publisher, rv.submission_id);
        if (o.error) fail(rv.submission_id, o.error);
        else report.repaired.push({ submission_id: rv.submission_id, kind: "revert.opened" });
        continue;
      }
      const gh = await publisher.getPullRequest({ repo: rv.repo, prNumber: rv.pr_number });
      if (gh.state === "open") continue;
      const sub = await getSub(db, rv.submission_id);
      const input = { number: rv.pr_number, mergeSha: gh.mergeSha, baseRef: gh.baseRef, d: null };
      const r = gh.merged ? await applyRevertMerged(db, rv, sub, input) : await applyRevertClosed(db, rv, sub, input);
      if (r.kind === "applied") report.repaired.push({ submission_id: sub.id, kind: gh.merged ? "revert.merged" : "revert.closed", from: r.from, to: r.to });
    } catch (e) {
      if (!(e instanceof ConflictError)) fail(rv.submission_id, e);
    }
  }
  return report;
}
