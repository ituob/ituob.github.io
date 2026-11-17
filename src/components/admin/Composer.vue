<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { IssueMetadataWire } from '../../lib/schema.generated';
import EditionMetadata from './EditionMetadata.vue';
import { api, canPlace, canStageEdition, generalMessageStatus, editionNumber, publicationNotice, type ComposerSubmission, type Edition, type EditionItem, type EditionGeneralMessage } from '../../lib/discussion-client';
import { composerPreviewLinks } from '../../lib/composer-preview';
defineProps<{ previousMetadata?: IssueMetadataWire | null }>();
interface EditionDetail { edition: Edition; items: EditionItem[]; general_messages: EditionGeneralMessage[] }
interface Pending { prNumber: number; url?: string; reason: string }
const editions = ref<Edition[]>([]), submissions = ref<ComposerSubmission[]>([]), detail = ref<EditionDetail | null>(null);
const number = ref<number | null>(null), busy = ref(false), loaded = ref(false), error = ref(''), notice = ref(''), pending = ref<Pending | null>(null);
const metadataRevision = ref<number | null>(null), metadataReview = ref<{ pr: { pr_url: string | null; pr_number: number | null }; pending: boolean; state?: { merged: boolean } | null } | null>(null);
async function metadataPr(check = false) { await perform(async () => {
  if (!detail.value) throw new Error('Choose an edition.');
  const endpoint = `${prefix}/editions/${detail.value.edition.ob_issue_no}/metadata`;
  metadataReview.value = check ? await api(`${endpoint}/pr`) : await api(`${endpoint}/open-pr`, 'POST', { expected_revision: metadataRevision.value });
}); }
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
async function select(no: number) { metadataRevision.value = null; metadataReview.value = null; detail.value = await api<EditionDetail>(`${prefix}/editions/${editionNumber(no)}`); pending.value = null; }
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
async function publish(step: 'stage' | 'publish') { await perform(async () => {
  if (!detail.value) throw new Error('Choose an edition.');
  const no = detail.value.edition.ob_issue_no;
  const result = await api<{ edition: Edition; published: string[]; pending?: Pending }>(`${prefix}/editions/${no}/${step}`, 'POST', {});
  pending.value = result.pending ?? null; await refresh();
  notice.value = publicationNotice(no, result, step);
}); }
onMounted(() => perform(refresh));
</script>
<template>
  <div :aria-busy="busy" class="admin-form composer">
    <nav><a href="/admin/">Administration</a> · <a href="/admin/submissions/">Review submissions</a></nav>
    <p class="admin-help">This composer requires ITU-admin access. Only merged patches may be placed into their approved target edition.</p>
    <p v-if="error" role="alert" class="admin-error">{{ error }}</p><p class="admin-status" v-if="notice" role="status">{{ notice }}</p>
    <p class="admin-status" v-if="pending" role="status">Staging PR {{ pending.prNumber }}: {{ pending.reason }} <a v-if="pendingUrl(pending.url)" :href="pendingUrl(pending.url)" target="_blank" rel="noopener noreferrer">Inspect staging PR</a></p>
    <form @submit.prevent="open"><fieldset class="admin-fieldset" :disabled="busy"><legend>Open edition</legend><label class="admin-field admin-label">OB edition number <input class="admin-control" v-model.number="number" required type="number" min="1" max="99999" step="1" /></label><button class="admin-button">Open or select edition</button></fieldset></form>
    <fieldset class="admin-fieldset" :disabled="busy"><legend>Editions</legend><button class="admin-button" @click="perform(refresh)">Refresh composer</button><p class="admin-help" v-if="loaded && !editions.length && !error">No editions have been opened.</p><ul><li v-for="edition in editions" :key="edition.ob_issue_no"><button class="admin-button" @click="perform(() => select(edition.ob_issue_no))">OB {{ edition.ob_issue_no }} · {{ edition.status }}</button></li></ul></fieldset>
    <section v-if="detail"><h2>OB {{ detail.edition.ob_issue_no }} · {{ detail.edition.status }}</h2>
      <EditionMetadata :key="detail.edition.ob_issue_no" :issue-no="detail.edition.ob_issue_no" :previous="previousMetadata" @saved="metadataRevision = $event.scheduled_at ? $event.revision : null" />
      <div><button class="admin-button" :disabled="busy || !metadataRevision" @click="metadataPr()">Open metadata review PR</button><button class="admin-button" :disabled="busy" @click="metadataPr(true)">Check metadata review</button>
        <p class="admin-status" v-if="metadataReview" role="status">Metadata {{ metadataReview.pending ? 'review pending' : 'merged' }} · PR {{ metadataReview.pr.pr_number ?? 'request reserved; retry to resume' }} <a v-if="pendingUrl(metadataReview.pr.pr_url || undefined)" :href="pendingUrl(metadataReview.pr.pr_url || undefined)" target="_blank" rel="noopener noreferrer">Inspect metadata PR</a></p>
      </div>
      <dl><dt>Frozen data revision</dt><dd>{{ detail.edition.freeze_sha || 'Not frozen' }}</dd><dt>Staging commit</dt><dd>{{ detail.edition.staging_commit || 'Not staged' }}</dd><dt>Publication recorded</dt><dd>{{ detail.edition.published_at || 'Not published' }}</dd></dl>
      <p class="admin-help">{{ detail.items.length }} register amendments · {{ detail.general_messages.length }} general messages</p>
      <p class="admin-help" v-if="!detail.items.length">No register amendments placed in this edition.</p>
      <ol><li v-for="item in detail.items" :key="item.submission_id">{{ item.slug }} · {{ item.action_type }} · {{ item.state }} · {{ item.submission_id }}<p class="admin-help">Patch: {{ item.path }} · Merged revision: {{ item.merge_sha || 'Unavailable' }}</p><p class="admin-help" v-if="composerPreviewLinks(item.slug, detail.edition.ob_issue_no, detail.edition.status)"><a :href="composerPreviewLinks(item.slug, detail.edition.ob_issue_no, detail.edition.status)?.current">Preview current register</a> · <a :href="composerPreviewLinks(item.slug, detail.edition.ob_issue_no, detail.edition.status)?.atIssue">Preview OB {{ detail.edition.ob_issue_no }} snapshot</a></p><button class="admin-button" v-if="detail.edition.status === 'composing'" :disabled="busy" @click="remove(item.submission_id)">Remove from edition</button></li></ol>
      <section aria-label="General messages in this edition"><h3>General messages</h3>
        <p class="admin-help">Every general draft targeting this issue must be approved and its exact review PR merged before publication. General messages are frozen while an edition is composing.</p>
        <p class="admin-help" v-if="!detail.general_messages.length">No general messages target this edition.</p>
        <ul><li v-for="message in detail.general_messages" :key="message.id">
          <p class="admin-help">{{ message.type }} · {{ message.path }} · revision {{ message.revision }} · {{ generalMessageStatus(message.status) }}</p>
          <a v-if="pendingUrl(message.pr_url || undefined)" :href="pendingUrl(message.pr_url || undefined)" target="_blank" rel="noopener noreferrer">Inspect general-message PR {{ message.pr_number }}</a>
          <details v-if="message.content_yaml"><summary>Approved message contents</summary><pre>{{ message.content_yaml }}</pre></details>
        </li></ul><a href="/admin/general/">Prepare and review general messages</a>
      </section>
      <button class="admin-button" v-if="canStageEdition(detail.edition, detail.items.length, detail.general_messages.length)" :disabled="busy" @click="publish('stage')">{{ pending ? 'Check staging and resume' : 'Stage edition (staging preview)' }}</button>
      <button class="admin-button" v-if="detail.edition.status === 'staged'" :disabled="busy" @click="publish('publish')">{{ pending ? 'Check production and resume publication' : 'Publish edition to production' }}</button>
    </section>
    <section><h2>Merged, unpublished submissions</h2><p class="admin-help" v-if="loaded && !submissions.length && !error">No merged submissions are waiting for publication.</p><ul><li v-for="submission in submissions" :key="submission.id"><p class="admin-help">{{ submission.register_id }} · {{ submission.action_type }} · {{ submission.id }} · {{ submission.state }} · Target OB {{ submission.target_edition }}<span v-if="submission.edition"> · Placed in OB {{ submission.edition }}</span><span v-if="submission.revert_state && submission.revert_state !== 'closed'"> · Revert {{ submission.revert_state }}</span></p><button class="admin-button" v-if="detail && canPlace(submission, detail.edition)" :disabled="busy" @click="place(submission)">Place in OB {{ detail.edition.ob_issue_no }}</button><a :href="`/admin/submissions/?id=${encodeURIComponent(submission.id)}`">Inspect submission</a></li></ul></section>
  </div>
</template>

<style src="../../styles/admin-forms.css"></style>
