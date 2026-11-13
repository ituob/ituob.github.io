import { generalBinding } from "../../src/lib/form/general.ts";
import { ConflictError } from "./membership.ts";
import type { PatchPublisher } from "./publisher.ts";
import { UpstreamError } from "./submissions.ts";

/** The whole issue-targeted selection, including drafts that are not publishable.
 * Leaving a draft out would silently omit authored issue content. */
export interface GeneralSelection {
  id: string; type: string; class_name: string; path: string; revision: number;
  value_json: string; approved_at: string | null; approved_by: string | null; content_yaml: string | null;
  review_revision: number | null; repo: string | null; branch: string | null;
  review_path: string | null; review_content_yaml: string | null;
  pr_number: number | null; commit_sha: string | null; pr_url: string | null;
}
const selectionQuery = `SELECT g.id,g.type,g.class_name,g.path,g.revision,g.value_json,g.approved_at,g.approved_by,g.content_yaml,
  p.revision AS review_revision,p.repo,p.branch,p.path AS review_path,p.content_yaml AS review_content_yaml,p.pr_number,p.commit_sha,p.pr_url
  FROM general_messages g LEFT JOIN general_message_prs p ON p.message_id=g.id
    AND p.revision=(SELECT max(revision) FROM general_message_prs WHERE message_id=g.id)
  WHERE g.ob_issue_no=?1 ORDER BY g.id`;
export async function generalSelection(db: D1Database, no: number): Promise<GeneralSelection[]> {
  return (await db.prepare(selectionQuery).bind(no).all<GeneralSelection>()).results;
}
/** Local checks precede the composing freeze so incomplete drafts can still be
 * corrected. Upstream merge verification happens after the atomic freeze. */
export function requireGeneralReviews(no: number, messages: GeneralSelection[]) {
  for (const message of messages) {
    const {className,relativePath}=generalBinding(message.type);
    const prefix=`ob-issues/${no}/`;
    const canonicalPath=relativePath.startsWith("general/") ? message.path === prefix+relativePath
      : message.path.startsWith(prefix) && new RegExp(`^${message.type}/(?!000)[0-9]{3}\\.yaml$`).test(message.path.slice(prefix.length));
    if(!canonicalPath || message.class_name!==className) throw new ConflictError(`general message ${message.id} has an invalid canonical class or path`);
    if(!message.approved_at || !message.approved_by || message.content_yaml===null)
      throw new ConflictError(`general message ${message.id} requires administrator approval before publication`);
    if(message.review_revision!==message.revision || message.review_path!==message.path || message.review_content_yaml!==message.content_yaml
      || !message.repo || message.branch!==`rt-msg-${no}-${message.id}-r${message.revision}` || !message.pr_number || !message.commit_sha)
      throw new ConflictError(`general message ${message.id} requires a review PR for its exact approved revision before publication`);
  }
}
export async function generalMergesForPublication(messages: GeneralSelection[], publisher: PatchPublisher) {
  const merges: {submissionId:string; mergeSha:string}[]=[];
  for(const message of messages) {
    let state;
    try { state=await publisher.getGeneralMessagePullRequest({repo:message.repo!,prNumber:message.pr_number!,expectedHeadSha:message.commit_sha!}); }
    catch(error) { throw new UpstreamError(`could not verify general message ${message.id}: ${error instanceof Error ? error.message : String(error)}`); }
    if(!state.merged || !state.mergeSha) throw new ConflictError(`general message ${message.id} review PR must be merged before publication`);
    merges.push({submissionId:`general-${message.id}-r${message.revision}`,mergeSha:state.mergeSha});
  }
  return merges;
}
/** Fail the surrounding D1 transaction if an approved value, reservation or the
 * set of issue-targeted records changed during an upstream request. */
export function requireGeneralSelection(db: D1Database, no: number, messages: GeneralSelection[]) {
  const keys: (keyof GeneralSelection)[]=["id","type","class_name","path","revision","value_json","approved_at","approved_by","content_yaml","review_revision","repo","branch","review_path","review_content_yaml","pr_number","commit_sha","pr_url"];
  return db.prepare(`INSERT INTO edition_items (ob_issue_no,submission_id,position)
    SELECT ?1,'-',NULL WHERE (SELECT count(*) FROM general_messages WHERE ob_issue_no=?1) != ?3
      OR EXISTS (SELECT 1 FROM json_each(?2) expected WHERE NOT EXISTS (
        SELECT 1 FROM (${selectionQuery}) current WHERE ${keys.map(key=>`current.${key} IS json_extract(expected.value,'$.${key}')`).join(" AND ")}
      ))`).bind(no,JSON.stringify(messages),messages.length);
}
export function generalMessageSummary(message: GeneralSelection, published: boolean) {
  return { id:message.id,type:message.type,path:message.path,revision:message.revision,approved_at:message.approved_at,
    content_yaml:message.content_yaml,pr_number:message.pr_number,pr_url:message.pr_url,
    status:published ? "published" : !message.approved_at ? "awaiting_approval" : message.review_revision!==message.revision ? "awaiting_review"
      : !message.pr_number ? "review_reserved" : "review_pr_created" };
}
