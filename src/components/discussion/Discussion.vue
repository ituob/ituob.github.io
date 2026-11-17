<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { api, commentBody, commentText, discussionPath, groupComments, submissionId, type CommentRevision, type DiscussionComment, type Thread } from '../../lib/discussion-client';
import CommentView from './CommentView.vue';
const id = ref(''), admin = ref(false), loadedId = ref(''), thread = ref<Thread | null>(null), viewer = ref('');
const busy = ref(false), error = ref(''), notice = ref(''), body = ref(''), reason = ref(''), parentId = ref(''), editId = ref('');
const input = ref<HTMLTextAreaElement | null>(null);
const anchorPath = ref(''), anchorQuote = ref(''), anchorRev = ref<number | null>(null), anchorLine = ref<number | null>(null);
const ownSubmissions = ref<{ id: string; register_id: string; state: string }[]>([]);
const history = ref<{ comments: DiscussionComment[]; revisions: CommentRevision[]; discussion: { closed: number; reason: string; at: string }[] } | null>(null);
const groups = computed(() => groupComments(thread.value?.comments ?? []));
const path = computed(() => discussionPath(loadedId.value, admin.value));
const canWrite = computed(() => !!thread.value && (!thread.value.discussion_closed || admin.value));
async function perform(work: () => Promise<void>) { busy.value = true; error.value = ''; notice.value = ''; try { await work(); } catch (e) { error.value = e instanceof Error ? e.message : 'Request failed'; } finally { busy.value = false; } }
function resetEditor() { body.value = ''; editId.value = ''; parentId.value = ''; anchorPath.value = ''; anchorQuote.value = ''; anchorRev.value = null; anchorLine.value = null; }
async function refresh() { thread.value = await api<Thread>(`${path.value}/comments`); }
async function open() {
  const next = submissionId(id.value.trim());
  const result = await api<Thread>(`${discussionPath(next, admin.value)}/comments`);
  loadedId.value = next; thread.value = result; history.value = null; resetEditor();
  const query = new URLSearchParams({ id: next, ...(admin.value ? { review: '1' } : {}) });
  window.history.replaceState(null, '', `${window.location.pathname}?${query}`);
}
async function focusEditor() { await nextTick(); input.value?.focus(); }
function reply(comment: DiscussionComment) { resetEditor(); parentId.value = comment.id; void focusEditor(); }
function edit(comment: DiscussionComment) { resetEditor(); editId.value = comment.id; body.value = commentText(comment); void focusEditor(); }
async function save() { await perform(async () => {
  const anchor = { ...(anchorRev.value ? { rev: anchorRev.value } : {}), ...(anchorPath.value ? { path: anchorPath.value } : {}), ...(anchorLine.value ? { line: anchorLine.value } : {}), ...(anchorQuote.value ? { quote: anchorQuote.value } : {}) };
  const payload = commentBody(body.value, parentId.value, anchor);
  await api(`${path.value}/comments${editId.value ? `/${editId.value}` : ''}`, editId.value ? 'PUT' : 'POST', editId.value ? { body: payload.body } : payload);
  resetEditor(); await refresh(); history.value = null; notice.value = 'Comment saved.';
}); }
async function remove(comment: DiscussionComment, restore = false) { await perform(async () => {
  if (admin.value && !reason.value.trim()) throw new Error('Enter a moderation reason first.');
  await api(`${path.value}/comments/${comment.id}${restore ? '/restore' : ''}`, restore ? 'POST' : 'DELETE', { reason: reason.value });
  if (editId.value === comment.id) resetEditor(); await refresh(); history.value = null; notice.value = restore ? 'Comment restored.' : 'Comment removed; its revision history is retained.';
}); }
async function moderate() { await perform(async () => {
  if (!reason.value.trim()) throw new Error('Enter a reason for closing or reopening the discussion.');
  await api(`${path.value}/discussion/${thread.value?.discussion_closed ? 'reopen' : 'close'}`, 'POST', { reason: reason.value });
  await refresh(); history.value = null; notice.value = 'Discussion state updated.';
}); }
function own(comment: DiscussionComment) { return comment.author_id === (thread.value?.viewer_user_id ?? (admin.value ? '' : viewer.value)); }
onMounted(() => perform(async () => {
  const query = new URLSearchParams(window.location.search); id.value = query.get('id') ?? ''; admin.value = query.get('review') === '1';
  // Access review can work independently of a member session.
  const identity = await api<{ authenticated: boolean; userId?: string }>('/api/whoami'); viewer.value = identity.userId ?? '';
  if (id.value) await open();
  else if (identity.authenticated && !admin.value) ownSubmissions.value = (await api<{ submissions: typeof ownSubmissions.value }>('/api/me/submissions')).submissions;
}));
</script>
<template>
  <div :aria-busy="busy" class="discussion">
    <nav><a href="/me/inbox/">Inbox and preferences</a> · <a href="/me/submissions/">My submissions</a> · <a v-if="admin" href="/admin/submissions/">ITU review queue</a></nav>
    <p v-if="error" role="alert" class="error">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
    <form @submit.prevent="perform(open)"><fieldset :disabled="busy"><legend>Open submission discussion</legend><label>Submission identifier <input v-model="id" required pattern="[0-9A-Z]{26}" /></label><label><input v-model="admin" type="checkbox" @change="thread = null; loadedId = ''; history = null; resetEditor()" />Use ITU Access review identity</label><button>Open discussion</button></fieldset></form>
    <ul v-if="ownSubmissions.length"><li v-for="sub in ownSubmissions" :key="sub.id"><button :disabled="busy" @click="id = sub.id; perform(open)">{{ sub.register_id }} · {{ sub.state }} · {{ sub.id }}</button></li></ul>
    <template v-if="thread">
      <h2>Discussion for {{ loadedId }}</h2><p role="status">{{ thread.discussion_closed ? 'Discussion closed' : 'Discussion open' }}</p>
      <p v-if="!groups.length">No comments yet.</p>
      <section v-for="group in groups" :key="group.root.id" :aria-label="`Thread ${group.root.id}`">
        <CommentView :comment="group.root" :can-edit="own(group.root)" :can-reply="canWrite" :admin="admin" :disabled="busy" @reply="reply" @edit="edit" @remove="remove" @restore="remove($event, true)" />
        <div class="replies"><CommentView v-for="comment in group.replies" :key="comment.id" :comment="comment" :can-edit="own(comment)" :can-reply="canWrite" :admin="admin" :disabled="busy" @reply="reply" @edit="edit" @remove="remove" @restore="remove($event, true)" /></div>
      </section>
      <form v-if="canWrite" @submit.prevent="save"><fieldset :disabled="busy"><legend>{{ editId ? `Revise comment ${editId}` : parentId ? `Reply to ${parentId}` : 'Add comment' }}</legend>
        <label>Comment (plain text, up to 8,000 characters)<textarea ref="input" v-model="body" required maxlength="8000" rows="6" /></label><p>Use @handle to mention a participant. Mentions do not grant access to a submission.</p>
        <details v-if="!editId"><summary>Attach to a submission field or line (optional)</summary><label>Field path <input v-model="anchorPath" maxlength="200" /></label><label>Line <input v-model.number="anchorLine" type="number" min="1" step="1" /></label><label>Submission revision (leave empty for current) <input v-model.number="anchorRev" type="number" min="1" step="1" /></label><label>Quoted text <textarea v-model="anchorQuote" maxlength="500" /></label></details>
        <button>{{ editId ? 'Save new comment revision' : 'Post comment' }}</button><button type="button" @click="resetEditor">Cancel / clear</button>
      </fieldset></form>
      <fieldset :disabled="busy"><legend>{{ admin ? 'Moderation' : 'Removal reason (optional)' }}</legend><label>Reason <textarea v-model="reason" rows="2" /></label><template v-if="admin"><p>A reason is required for moderation. The service checks ITU permissions.</p><button :disabled="!reason.trim()" @click="moderate">{{ thread.discussion_closed ? 'Reopen discussion' : 'Close discussion' }}</button></template></fieldset>
      <button :disabled="busy" @click="perform(async () => { history = await api(`${path}/history`); })">Load complete revision and moderation history</button>
      <section v-if="history"><h3>Revision and moderation history</h3><p>History includes removed comment text for authorized participants.</p><details v-for="comment in history.comments" :key="comment.id"><summary>{{ comment.author_id }} · {{ comment.id }}{{ comment.deleted_at ? ' · removed' : '' }}</summary><ol><li v-for="revision in history.revisions.filter(r => r.comment_id === comment.id)" :key="revision.rev">Revision {{ revision.rev }} · {{ revision.created_at }}<p class="body">{{ revision.body }}</p></li></ol></details><ol><li v-for="(event, index) in history.discussion" :key="index">{{ event.at }}: {{ event.closed ? 'Closed' : 'Reopened' }} — {{ event.reason }}</li></ol></section>
    </template>
  </div>
</template>
<style scoped>.discussion { max-width: 70rem; margin: 2rem auto; } fieldset { border: 1px solid #9baaba; margin: 1rem 0; padding: 1rem; } label { display: block; margin: .6rem 0; } textarea { display: block; width: 100%; } input, textarea, button { border: 1px solid #708397; border-radius: .2rem; padding: .4rem; max-width: 100%; } button { margin: .25rem; } .error { color: #a51b27; } .replies { margin-left: 2rem; } .body { white-space: pre-wrap; overflow-wrap: anywhere; }</style>
