<script setup lang="ts">
import '../../styles/admin-forms.css';
import { computed, onMounted, ref, toRaw } from 'vue';
import { api, ApiError } from '../../lib/admin-client';
import { ANNEX_TYPE, annexPublication, pickerCandidates, zurichPositionDay, publicationIdError, removeAnnex, runningAnnexes, setAnnexPosition, validateAnnexes, type AnnexIndexEntry, type AnnexesWire, type AnnexIssue } from '../../lib/form/annexes';
import type { GeneralMessage } from '../../../worker/lib/general-messages';

const endpoint = '/api/admin/general-messages';
const issueNo = ref(1351), query = ref('');
const index = ref<AnnexIndexEntry[]>([]);
const drafts = ref<GeneralMessage[]>([]), draft = ref<GeneralMessage | null>(null);
const wire = ref<AnnexesWire>({});
const published = ref<Record<string, AnnexesWire>>({}), ready = ref(false);
const busy = ref(false), error = ref(''), notice = ref('');
const errors = ref<AnnexIssue[]>([]);
const running = computed(() => runningAnnexes(index.value, issueNo.value));
const candidates = computed(() => pickerCandidates(index.value, issueNo.value, query.value));
const newId = computed(() => query.value.trim());
const canUseNewId = computed(() => newId.value !== '' && !publicationIdError(newId.value) && !Object.hasOwn(wire.value, newId.value) && !candidates.value.some(c => c.id === newId.value));
const dirty = computed(() => JSON.stringify(wire.value) !== JSON.stringify(draft.value?.value ?? {}));
const rows = computed(() => Object.entries(wire.value));

function load(no: number) {
  const found = drafts.value.find(item => item.type === ANNEX_TYPE && item.ob_issue_no === no) ?? null;
  draft.value = found; wire.value = structuredClone(toRaw((found?.value ?? published.value[no] ?? {}) as AnnexesWire)); errors.value = [];
}
async function perform(work: () => Promise<void>) {
  busy.value = true; error.value = ''; notice.value = ''; errors.value = [];
  try { await work(); }
  catch (e) { error.value = e instanceof Error ? e.message : 'Annex request failed'; if (e instanceof ApiError) errors.value = e.errors as AnnexIssue[]; }
  finally { busy.value = false; }
}
async function reload() { drafts.value = (await api<{ drafts: GeneralMessage[] }>(endpoint)).drafts.filter(item => item.type === ANNEX_TYPE); load(issueNo.value); }
function accept(value: GeneralMessage) { draft.value = value; issueNo.value = value.ob_issue_no; wire.value = structuredClone(toRaw(value.value as AnnexesWire)); }
function annex(id: string) { wire.value = annexPublication(wire.value, id, running.value); query.value = ''; }
function remove(id: string) { wire.value = removeAnnex(wire.value, id); }
function position(id: string, value: string) { wire.value = setAnnexPosition(wire.value, id, value); }
async function save() {
  await perform(async () => {
    errors.value = validateAnnexes(wire.value);
    if (errors.value.length) return;
    const url = draft.value ? `${endpoint}/${draft.value.id}` : endpoint;
    const input = draft.value ? { value: wire.value, expected_revision: draft.value.revision } : { value: wire.value, type: ANNEX_TYPE, ob_issue_no: issueNo.value };
    accept((await api<{ draft: GeneralMessage }>(url, 'POST', input)).draft);
    await reload(); notice.value = 'Annexes saved. An administrator must approve this revision before publication review.';
  });
}
async function approve() {
  if (!draft.value) return;
  await perform(async () => {
    accept((await api<{ draft: GeneralMessage }>(`${endpoint}/${draft.value!.id}/approve`, 'POST', { expected_revision: draft.value!.revision })).draft);
    await reload(); notice.value = 'Approved YAML frozen. Open its review PR before publication.';
  });
}
async function openReview() {
  if (!draft.value) return;
  await perform(async () => {
    const result = await api<{ pr: { pr_url: string | null } }>(`${endpoint}/${draft.value!.id}/review`, 'POST', { expected_revision: draft.value!.revision });
    notice.value = result.pr.pr_url ? `Publication review: ${result.pr.pr_url}` : 'Review request reserved. Retry to obtain the PR link.';
  });
}
onMounted(async () => {
  try { index.value = await (await fetch('/annex-index.json')).json(); } catch { error.value = 'The annex index could not be loaded; publications can still be added by id.'; }
  await perform(async () => {
    published.value = (await api<{ annexes: Record<string, AnnexesWire> }>('/annexes.json')).annexes;
    await reload(); ready.value = true;
  });
});
</script>
<template>
  <section class="admin-form" :aria-busy="busy" aria-label="Annex authoring">
    <p class="admin-help">Annex service publications to an issue and set the position (date) of each annexed list. Running annexes, those already annexed to an earlier issue, are listed first. Datasets stored in an existing annex are preserved but not editable here.</p>
    <p class="admin-error" v-if="error" role="alert">{{ error }}</p><p class="admin-status" v-if="notice" role="status">{{ notice }}</p>
    <ul class="admin-error" v-if="errors.length" role="alert"><li v-for="(issue, i) in errors" :key="i">{{ issue.path }}: {{ issue.message }}</li></ul>
    <fieldset class="admin-fieldset" :disabled="busy || !ready"><legend>Issue</legend>
      <label class="admin-field admin-label">Issue number <input class="admin-control" v-model.number="issueNo" type="number" min="1" max="99999" :disabled="!!draft && dirty" @change="load(issueNo)" /></label>
    </fieldset>
    <fieldset class="admin-fieldset" :disabled="busy || !ready"><legend>Annex a publication</legend>
      <label class="admin-field admin-label">Publication <input class="admin-control" v-model="query" type="search" placeholder="Type a publication id" aria-label="Filter publications" /></label>
      <ul aria-label="Publications to annex">
        <li v-for="item in candidates.slice(0, 12)" :key="item.id">
          <button class="admin-button" type="button" :disabled="Object.hasOwn(wire, item.id)" :title="Object.hasOwn(wire, item.id) ? 'Already annexed to this issue' : undefined" @click="annex(item.id)">{{ item.id }}</button>
          <small class="admin-help" v-if="item.running"> running since OB {{ item.annexed_to }}{{ item.position_on ? `, position ${zurichPositionDay(item.position_on) || item.position_on}` : ', position unknown' }}</small>
        </li>
      </ul>
      <button class="admin-button" v-if="canUseNewId" type="button" @click="annex(newId)">Use “{{ newId }}” as a new publication id</button>
    </fieldset>
    <fieldset class="admin-fieldset" :disabled="busy || !ready"><legend>Annexed to OB {{ issueNo }}</legend>
      <p class="admin-help" v-if="!rows.length"><em>Nothing annexed yet.</em></p>
      <ul v-else>
        <li v-for="[id, entry] in rows" :key="id">
          <strong>{{ id }}</strong>
          <label class="admin-field admin-label"> Position <input class="admin-control" type="date" :value="zurichPositionDay(entry?.position_on)" :aria-label="`Position of ${id}`" @change="position(id, ($event.target as HTMLInputElement).value)" /></label>
          <small class="admin-help" v-if="entry?.position_on && zurichPositionDay(entry.position_on) !== entry.position_on"> stored as {{ entry.position_on }}</small>
          <small class="admin-help" v-if="!entry?.position_on"> position unspecified</small>
          <small class="admin-help" v-if="entry?.datasets"> carries datasets (kept)</small>
          <button class="admin-button" type="button" @click="remove(id)">Remove</button>
        </li>
      </ul>
      <button class="admin-button admin-button-primary" type="button" @click="save">Save draft</button>
      <button class="admin-button" type="button" :disabled="!draft || dirty || !!draft.approved_at" @click="approve">Approve saved revision (administrator)</button>
      <button class="admin-button" type="button" :disabled="!draft?.approved_at || dirty" @click="openReview">Open publication review PR (administrator)</button>
    </fieldset>
    <p class="admin-help" v-if="draft">{{ draft.path }} · revision {{ draft.revision }} · {{ draft.approved_at ? 'Approved; publication still requires a reviewed and merged PR.' : 'Awaiting administrator approval.' }}</p>
    <p class="admin-help" v-if="dirty && draft">Unsaved changes. Saving creates a new revision and clears approval.</p>
    <details v-if="draft?.content_yaml"><summary>Exact approved YAML artifact</summary><pre>{{ draft.content_yaml }}</pre></details>
  </section>
</template>
