import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, canPlace, commentBody, commentText, discussionLink, discussionPath, editionNumber, groupComments, notificationPayload, publicationNotice, type ComposerSubmission, type DiscussionComment, type Edition } from '../discussion-client';
function comment(overrides: Partial<DiscussionComment> = {}): DiscussionComment {
  return { id: '01AAAAAAAAAAAAAAAAAAAAAAAA', root_id: '01AAAAAAAAAAAAAAAAAAAAAAAA', parent_id: null, author_id: 'member-a', kind: 'comment', affiliation_kind: 'member', affiliation_member_id: 'FR', current_rev: 2, deleted_at: null, delete_reason: null, created_at: '2026-11-13', anchor_rev: null, anchor_path: null, anchor_line: null, anchor_quote: null, revisions: [{ comment_id: '01AAAAAAAAAAAAAAAAAAAAAAAA', rev: 1, body: 'Original text', mentions: '[]', created_at: '2026-11-12' }, { comment_id: '01AAAAAAAAAAAAAAAAAAAAAAAA', rev: 2, body: 'Revised text @reviewer', mentions: '[{"handle":"reviewer","user_id":"itu"}]', created_at: '2026-11-13' }], ...overrides };
}
const edition: Edition = { ob_issue_no: 1351, status: 'composing', freeze_sha: null, meta_pr: null, staging_commit: null, published_at: null };
const item: ComposerSubmission = { id: '01AAAAAAAAAAAAAAAAAAAAAAAA', register_id: 'E118_IIN', slug: 'e118-iin', action_type: 'ADD', state: 'merged', target_edition: 1351, edition: null, revert_state: null, pr_number: 42 };
afterEach(() => vi.unstubAllGlobals());
describe('discussion editing and rendering contracts', () => {
  it('preserves plain text, mentions, reply identity, and structured anchors', () => {
    const body = '  Correction @reviewer\n<em>plain text</em>  ';
    expect(commentBody(body, item.id, { rev: 2, path: 'data.entries[0].company_name', quote: 'Previous name' })).toEqual({ body, parent_id: item.id, anchor: { rev: 2, path: 'data.entries[0].company_name', quote: 'Previous name' } });
    expect(() => commentBody('   ')).toThrow('Write a comment');
    expect(() => commentBody('x'.repeat(8001))).toThrow('8,000');
    expect(() => commentBody('text', undefined, { quote: 'lost quote' })).toThrow('field path or line');
  });
  it('shows the current immutable revision and keeps tombstones in their threads', () => {
    const root = comment({ deleted_at: '2026-11-13' });
    const reply = comment({ id: '01BBBBBBBBBBBBBBBBBBBBBBBB', parent_id: root.id });
    expect(commentText(root)).toBe('Comment removed');
    expect(commentText(reply)).toBe('Revised text @reviewer');
    expect(groupComments([root, reply])).toEqual([{ root, replies: [reply] }]);
    expect(root.revisions[0]?.body).toBe('Original text');
  });
  it('does not lose orphaned replies and refuses arbitrary identifier routes', () => {
    const orphan = comment({ root_id: '01CCCCCCCCCCCCCCCCCCCCCCCC' });
    expect(groupComments([orphan])).toEqual([{ root: orphan, replies: [] }]);
    expect(discussionPath(item.id, true)).toBe(`/api/admin/submissions/${item.id}`);
    expect(discussionLink(item.id)).toBe(`/me/discussions/?id=${item.id}`);
    expect(() => discussionPath('../private')).toThrow('submission identifier');
  });
  it('decodes notification excerpts without treating payload fields as markup or URLs', () => {
    expect(notificationPayload('{"excerpt":"<script>plain text</script>","actor_name":"Member","count":3}')).toEqual({ excerpt: '<script>plain text</script>', actor_name: 'Member' });
    expect(notificationPayload('invalid')).toEqual({});
  });
});
describe('admin composer contract', () => {
  it('places only merged items in their matching editable edition without a pending revert', () => {
    expect(canPlace(item, edition)).toBe(true);
    expect(canPlace({ ...item, state: 'scheduled' }, edition)).toBe(false);
    expect(canPlace({ ...item, target_edition: 1350 }, edition)).toBe(false);
    expect(canPlace({ ...item, revert_state: 'open' }, edition)).toBe(false);
    expect(canPlace(item, { ...edition, status: 'published' })).toBe(false);
    expect(canPlace({ ...item, revert_state: 'closed' }, edition)).toBe(true);
    expect(() => editionNumber(1.5)).toThrow('edition number');
  });
  it('never describes pending staging or a composing response as published', () => {
    const pending = { edition, published: [], pending: { prNumber: 44, reason: 'Awaiting required staging checks' } };
    expect(publicationNotice(1351, pending)).toContain('waiting for staging');
    expect(publicationNotice(1351, { edition, published: [] })).toContain('Publication is not confirmed');
    expect(publicationNotice(1351, { edition: { ...edition, status: 'published' }, published: [item.id] })).toContain('service recorded');
  });
  it('retains HTTP 202 pending data and sends same-origin credentials', async () => {
    const result = { ok: true, edition, published: [], pending: { prNumber: 44, url: 'https://github.com/example/site/pull/44', reason: 'Awaiting merge' } };
    const fetcher = vi.fn().mockResolvedValue(Response.json(result, { status: 202 })); vi.stubGlobal('fetch', fetcher);
    expect(await api('/api/admin/composer/editions/1351/publish', 'POST', {})).toEqual(result);
    expect(fetcher).toHaveBeenCalledWith('/api/admin/composer/editions/1351/publish', expect.objectContaining({ credentials: 'same-origin', method: 'POST', body: '{}' }));
  });
  it('surfaces provider failure and ownership rejection without a success result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'could not bump the data pin: provider is not configured' }, { status: 502 })));
    await expect(api('/api/admin/composer/editions/1351/publish', 'POST', {})).rejects.toThrow('provider is not configured');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'forbidden' }, { status: 403 })));
    await expect(api('/api/me/submissions/x/comments/y', 'PUT', { body: 'rewrite' })).rejects.toMatchObject({ status: 403 });
  });
});
