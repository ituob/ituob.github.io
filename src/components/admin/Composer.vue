<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, canPlace, editionNumber, publicationNotice, type ComposerSubmission, type Edition, type EditionItem } from '../../lib/discussion-client';
interface EditionDetail { edition: Edition; items: EditionItem[] }
interface Pending { prNumber: number; url?: string; reason: string }
const editions = ref<Edition[]>([]), submissions = ref<ComposerSubmission[]>([]), detail = ref<EditionDetail | null>(null);
const number = ref<number | null>(null), busy = ref(false), loaded = ref(false), error = ref(''), notice = ref(''), pending = ref<Pending | null>(null);
const prefix = '/api/admin/composer';
function pendingUrl(value?: string) { try { const url = new URL(value ?? ''); return url.protocol === 'https:' ? url.href : undefined; } catch { return undefined; } }
async function perform(work: () => Promise<void>) { busy.value = true; error.value = ''; notice.value = ''; try { await work(); } catch (e) { error.value = e instanceof Error ? e.message : 'Request failed'; } finally { busy.value = false; } }
async function refresh() {
  const [list, merged] = await Promise.all([api<{ editions: Edition[] }>(`${prefix}/editions`), api<{ submissions: ComposerSubmission[] }>(`${prefix}/submissions`)]);
  editions.value = list.editions; submissions.value = merged.submissions; loaded.value = true;
  const previousNo = detail.value?.edition.ob_issue_no;
  const selected = editions.value.find(e => e.ob_issue_no === detail.value?.edition.ob_issue_no) ?? editions.value[0];
  detail.value = selected ? await api<EditionDetail>(`${prefix}/editions/${selected.ob_issue_no}`) : null;
  if (selected?.ob_issue_no !== previousNo || detail.value?.edition.status === 'published') pending.value = null;
}
async function select(no: number) { detail.value = await api<EditionDetail>(`${prefix}/editions/${editionNumber(no)}`); pending.value = null; }
async function open() { await perform(async () => {
  const no = editionNumber(Number(number.value));
  await api(`${prefix}/editions`, 'POST', { ob_issue_no: no }); await refresh(); await select(no); notice.value = `Edition ${no} selected. Current state: ${detail.value?.edition.status}.`;
}); }
async function place(submission: ComposerSubmission) { await perform(async () => {
  if (!detail.value || !canPlace(submission, detail.value.edition)) throw new Error('Choose an open edition matching the submission target, with no pending revert.');
  await api(`${prefix}/editions/${detail.value.edition.ob_issue_no}/items`, 'POST', { submission_id: submission.id }); await refresh(); notice.value = 'Submission placed in the edition.';
}); }
async function remove(id: string) { await perform(async () => {
  if (!detail.value) throw new Error('Choose an edition.');
  await api(`${prefix}/editions/${detail.value.edition.ob_issue_no}/items/${id}/remove`, 'POST', {}); await refresh(); notice.value = 'Submission removed from the edition.';
}); }
async function publish() { await perform(async () => {
  if (!detail.value) throw new Error('Choose an edition.');
  const no = detail.value.edition.ob_issue_no;
  const result = await api<{ edition: Edition; published: string[]; pending?: Pending }>(`${prefix}/editions/${no}/publish`, 'POST', {});
  pending.value = result.pending ?? null; await refresh();
  notice.value = publicationNotice(no, result);
}); }
onMounted(() => perform(refresh));
</script>
<template>
  <div :aria-busy="busy" class="composer">
    <nav><a href="/admin/">Administration</a> · <a href="/admin/submissions/">Review submissions</a></nav>
    <p>This composer requires ITU-admin access. Only merged patches may be placed into their approved target edition.</p>
    <p v-if="error" role="alert" class="error">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="pending" role="status">Staging PR {{ pending.prNumber }}: {{ pending.reason }} <a v-if="pendingUrl(pending.url)" :href="pendingUrl(pending.url)" target="_blank" rel="noopener noreferrer">Inspect staging PR</a></p>
    <form @submit.prevent="open"><fieldset :disabled="busy"><legend>Open edition</legend><label>OB edition number <input v-model.number="number" required type="number" min="1" max="99999" step="1" /></label><button>Open or select edition</button></fieldset></form>
    <fieldset :disabled="busy"><legend>Editions</legend><button @click="perform(refresh)">Refresh composer</button><p v-if="loaded && !editions.length && !error">No editions have been opened.</p><ul><li v-for="edition in editions" :key="edition.ob_issue_no"><button @click="perform(() => select(edition.ob_issue_no))">OB {{ edition.ob_issue_no }} · {{ edition.status }}</button></li></ul></fieldset>
    <section v-if="detail"><h2>OB {{ detail.edition.ob_issue_no }} · {{ detail.edition.status }}</h2>
      <dl><dt>Frozen data revision</dt><dd>{{ detail.edition.freeze_sha || 'Not frozen' }}</dd><dt>Staging commit</dt><dd>{{ detail.edition.staging_commit || 'Not staged' }}</dd><dt>Publication recorded</dt><dd>{{ detail.edition.published_at || 'Not published' }}</dd></dl>
      <p v-if="!detail.items.length">No items placed in this edition.</p>
      <ol><li v-for="item in detail.items" :key="item.submission_id">{{ item.slug }} · {{ item.action_type }} · {{ item.state }} · {{ item.submission_id }}<p>Patch: {{ item.path }} · Merged revision: {{ item.merge_sha || 'Unavailable' }}</p><button v-if="detail.edition.status === 'composing'" :disabled="busy" @click="remove(item.submission_id)">Remove from edition</button></li></ol>
      <button v-if="['composing','staged'].includes(detail.edition.status) && detail.items.length" :disabled="busy" @click="publish">{{ pending ? 'Check staging and resume publication' : detail.edition.status === 'staged' ? 'Resume edition publication' : 'Publish edition through staging' }}</button>
    </section>
    <section><h2>Merged, unpublished submissions</h2><p v-if="loaded && !submissions.length && !error">No merged submissions are waiting for publication.</p><ul><li v-for="submission in submissions" :key="submission.id"><p>{{ submission.register_id }} · {{ submission.action_type }} · {{ submission.id }} · {{ submission.state }} · Target OB {{ submission.target_edition }}<span v-if="submission.edition"> · Placed in OB {{ submission.edition }}</span><span v-if="submission.revert_state && submission.revert_state !== 'closed'"> · Revert {{ submission.revert_state }}</span></p><button v-if="detail && canPlace(submission, detail.edition)" :disabled="busy" @click="place(submission)">Place in OB {{ detail.edition.ob_issue_no }}</button><a :href="`/admin/submissions/?id=${encodeURIComponent(submission.id)}`">Inspect submission</a></li></ul></section>
  </div>
</template>
<style scoped>.composer { max-width: 70rem; margin: 2rem auto; } fieldset { border: 1px solid #9baaba; margin: 1rem 0; padding: 1rem; } label { display: block; margin: .5rem 0; } input, button { border: 1px solid #708397; border-radius: .2rem; padding: .4rem; } button { margin: .25rem; } .error { color: #a51b27; } dd, p { overflow-wrap: anywhere; } dt { font-weight: bold; }</style>
