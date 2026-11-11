// System comments (kind='system'): the discussion thread's record of a state
// change. Written inside the transition's own db.batch, guarded by the new
// submission version, so a rolled-back transition leaves no comment.
import { ulid } from "./ulid.ts";

/** Two statements: the comment (author-less) and its revision, both guarded by the submission's new version. */
export function systemCommentStatements(db: D1Database, submissionId: string, version: number, at: string, text: string): D1PreparedStatement[] {
  const id = ulid();
  return [
    db
      .prepare(
        `INSERT INTO comments (id,submission_id,parent_id,root_id,author_id,affiliation_kind,affiliation_member_id,kind,current_rev,created_at)
         SELECT ?1,?2,NULL,?1,NULL,NULL,NULL,'system',1,?3
          WHERE EXISTS (SELECT 1 FROM submissions WHERE id=?2 AND version=?4)`,
      )
      .bind(id, submissionId, at, version),
    db
      .prepare(`INSERT INTO comment_revisions (comment_id,rev,body,mentions,edited_by,created_at) SELECT ?1,1,?2,'[]',NULL,?3 WHERE EXISTS (SELECT 1 FROM comments WHERE id=?1)`)
      .bind(id, text, at),
  ];
}
