import { requireRole } from "./authz.ts";
import { metadataArtifact } from "./edition-metadata.ts";
import { ConflictError, NotFoundError } from "./membership.ts";
import type { PatchPublisher } from "./publisher.ts";
import { UpstreamError } from "./submissions.ts";
import type { Session } from "./types.ts";

interface MetadataPr {
  ob_issue_no: number;
  revision: number;
  repo: string;
  branch: string;
  path: string;
  content_yaml: string;
  pr_number: number | null;
  commit_sha: string | null;
  pr_url: string | null;
}
const reservation = (db: D1Database, no: number) => db.prepare(
  "SELECT * FROM edition_metadata_prs WHERE ob_issue_no=?1 ORDER BY revision DESC LIMIT 1",
).bind(no).first<MetadataPr>();

/** Reserve immutable bytes before GitHub, so a response crash can be retried safely. */
export async function openMetadataReview(db: D1Database, session: Session | null, no: number, revision: number, repo: string, publisher: PatchPublisher) {
  requireRole(session, "itu-admin");
  const artifact = await metadataArtifact(db, no, revision);
  const branch = `rt-meta-${no}-r${artifact.revision}`;
  await db.prepare(`INSERT INTO edition_metadata_prs (ob_issue_no,revision,repo,branch,path,content_yaml)
    SELECT ?1,?2,?3,?4,?5,?6 FROM edition_metadata
    WHERE ob_issue_no=?1 AND revision=?2 AND scheduled_at IS NOT NULL
    ON CONFLICT(ob_issue_no,revision) DO NOTHING`)
    .bind(no, artifact.revision, repo, branch, artifact.path, artifact.content).run();
  let stored = await reservation(db, no);
  if (!stored || stored.revision !== artifact.revision || stored.repo !== repo || stored.branch !== branch || stored.path !== artifact.path || stored.content_yaml !== artifact.content)
    throw new ConflictError("metadata changed while preparing its review PR");
  try {
    const pr = await publisher.openMetadataPr({ repo, branch, path: stored.path, content: stored.content_yaml,
      edition: no, revision: stored.revision, title: `OB ${no}: issue metadata`,
      body: "Review the authored issue metadata and publication dates. This PR does not publish the edition.",
      idempotencyKey: `metadata-${no}-r${stored.revision}` });
    if (stored.pr_number !== null && (stored.pr_number !== pr.prNumber || stored.commit_sha !== pr.commitSha))
      throw new ConflictError("metadata publisher returned a different review PR");
    await db.batch([
      db.prepare(`UPDATE edition_metadata_prs SET pr_number=?3,commit_sha=?4,pr_url=?5
        WHERE ob_issue_no=?1 AND revision=?2 AND (pr_number IS NULL OR (pr_number=?3 AND commit_sha=?4))`)
        .bind(no, stored.revision, pr.prNumber, pr.commitSha, pr.url),
      db.prepare(`UPDATE editions SET meta_pr=(SELECT pr_number FROM edition_metadata_prs WHERE ob_issue_no=?1 AND revision=?2)
        WHERE ob_issue_no=?1 AND status IN ('open','composing')`).bind(no, stored.revision),
    ]);
    stored = (await reservation(db, no))!;
    if (stored.pr_number !== pr.prNumber || stored.commit_sha !== pr.commitSha) throw new ConflictError("metadata review changed concurrently");
    return { pr: stored, pending: true };
  } catch (error) {
    if (error instanceof ConflictError) throw error;
    throw new UpstreamError(error instanceof Error ? error.message : "metadata PR unavailable");
  }
}

/** Optional for legacy issues; any newly authored metadata must be merged first. */
export async function metadataMergeForPublication(db: D1Database, session: Session | null, no: number, publisher: PatchPublisher) {
  requireRole(session, "itu-admin");
  const metadata = await db.prepare("SELECT revision FROM edition_metadata WHERE ob_issue_no=?1").bind(no).first<{ revision: number }>();
  if (!metadata) return null;
  const result = await readMetadataReview(db, session, no, publisher);
  if (result.pr.revision !== metadata.revision || !result.state?.merged || !result.state.mergeSha)
    throw new ConflictError("edition metadata review must be merged before publication");
  return { submissionId: `edition-${no}-metadata-r${metadata.revision}`, mergeSha: result.state.mergeSha };
}

export async function readMetadataReview(db: D1Database, session: Session | null, no: number, publisher: PatchPublisher) {
  requireRole(session, "itu-admin", "itu-editor");
  const stored = await reservation(db, no);
  if (!stored) throw new NotFoundError("no metadata review has been prepared");
  if (stored.pr_number === null) return { pr: stored, pending: true, state: null };
  try {
    const state = await publisher.getMetadataPullRequest({ repo: stored.repo, prNumber: stored.pr_number });
    return { pr: stored, pending: !state.merged, state };
  } catch (error) { throw new UpstreamError(error instanceof Error ? error.message : "metadata PR unavailable"); }
}
