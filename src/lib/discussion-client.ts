import { api } from './admin-client';
export { api };
export interface CommentRevision { comment_id: string; rev: number; body: string; mentions: string; created_at: string }
export interface DiscussionComment {
  id: string; parent_id: string | null; root_id: string; author_id: string; kind: string;
  affiliation_kind: string | null; affiliation_member_id: string | null; current_rev: number;
  deleted_at: string | null; delete_reason: string | null; created_at: string;
  anchor_rev: number | null; anchor_path: string | null; anchor_line: number | null; anchor_quote: string | null;
  revisions: CommentRevision[];
}
export interface Thread { discussion_closed: boolean; viewer_user_id?: string; comments: DiscussionComment[] }
export interface Notification { id: string; submission_id: string; kind: string; payload: string; read_at: string | null; created_at: string; email_status: string; email_reason: string | null }
export interface Edition { ob_issue_no: number; status: 'open' | 'composing' | 'staged' | 'published'; freeze_sha: string | null; meta_pr: number | null; staging_commit: string | null; published_at: string | null }
export interface ComposerSubmission { id: string; register_id: string; slug: string; action_type: string; state: string; target_edition: number; edition: number | null; revert_state: string | null; pr_number: number | null }
export interface EditionItem { submission_id: string; position: number; state: string; slug: string; action_type: string; merge_sha: string | null; path: string }
export interface EditionGeneralMessage { id: string; type: string; path: string; revision: number; approved_at: string | null; content_yaml: string | null; pr_number: number | null; pr_url: string | null; status: 'awaiting_approval' | 'awaiting_review' | 'review_reserved' | 'review_pr_created' | 'published' }
export function canPublishEdition(edition: Edition, registerCount: number, generalCount: number): boolean {
  return ['open', 'composing', 'staged'].includes(edition.status) && registerCount + generalCount > 0;
}
export function generalMessageStatus(status: EditionGeneralMessage['status']): string {
  return { awaiting_approval: 'Awaiting administrator approval', awaiting_review: 'Awaiting publication review PR', review_reserved: 'Review request reserved; retry in general messages', review_pr_created: 'Review PR created; its merge is verified when publishing', published: 'Included in published issue' }[status];
}
export function submissionId(value: string): string {
  if (!/^[0-9A-Z]{26}$/.test(value)) throw new Error('Enter a 26-character submission identifier.');
  return value;
}
export function discussionPath(id: string, admin = false): string {
  return `/api/${admin ? 'admin' : 'me'}/submissions/${submissionId(id)}`;
}
export function discussionLink(id: string): string { return `/me/discussions/?id=${encodeURIComponent(submissionId(id))}`; }
export function commentBody(body: string, parentId?: string, anchor?: { rev?: number; path?: string; line?: number; quote?: string }) {
  if (!body.trim()) throw new Error('Write a comment before saving.');
  if (body.length > 8000) throw new Error('Comments must be at most 8,000 characters.');
  if (anchor && Object.keys(anchor).length && !anchor.path && !anchor.line) throw new Error('An anchor needs a field path or line number.');
  return { body, ...(parentId ? { parent_id: submissionId(parentId) } : {}), ...(anchor && (anchor.path || anchor.line) ? { anchor } : {}) };
}
export function commentText(comment: DiscussionComment): string {
  if (comment.deleted_at) return 'Comment removed';
  return comment.revisions.find(revision => revision.rev === comment.current_rev)?.body ?? 'Comment text is unavailable.';
}
/** API threads have two levels; preserve roots with tombstones and attach replies by root_id. */
export function groupComments(comments: DiscussionComment[]) {
  const roots = comments.filter(comment => comment.root_id === comment.id || !comments.some(root => root.id === comment.root_id));
  return roots.map(root => ({ root, replies: comments.filter(comment => comment.id !== root.id && comment.root_id === root.id) }));
}
export function notificationPayload(payload: string): Record<string, string> {
  try {
    const value = JSON.parse(payload);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch { return {}; }
}
export function editionNumber(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 99999) throw new Error('Enter an OB edition number from 1 to 99,999.');
  return value;
}
export function canPlace(item: ComposerSubmission, edition: Edition): boolean {
  return ['open', 'composing'].includes(edition.status) && item.state === 'merged' && item.target_edition === edition.ob_issue_no && (!item.revert_state || item.revert_state === 'closed');
}

export interface PublicationResult { edition: Edition; published: string[]; pending?: { prNumber: number; url?: string; reason: string } }
export function publicationNotice(no: number, result: PublicationResult): string {
  if (result.pending) return `Edition ${no} is waiting for staging: ${result.pending.reason}`;
  if (result.edition.status === 'published') return `The service recorded edition ${no} as published. See its publication evidence below.`;
  return `The service returned edition status ${result.edition.status}. Publication is not confirmed.`;
}
