<script setup lang="ts">
import '../../styles/admin-forms.css';
import { computed, onMounted, ref } from 'vue';
import { api, ApiError } from '../../lib/admin-client';
import { GENERAL_TYPES, generalBinding, newGeneralState } from '../../lib/form/general';
import { blankState, toFormState, toInstance, type FormNode } from '../../lib/form/model';
import { validateClass, type SchemaIssue } from '../../lib/schema.validators.generated';
import type { GeneralMessage } from '../../../worker/lib/general-messages';
import SchemaNode from './SchemaNode.vue';

defineProps<{ translation?: boolean }>();

const drafts = ref<GeneralMessage[]>([]), draft = ref<GeneralMessage | null>(null);
const issueNo = ref(1331), type = ref<string>('misc_communications');
const node = ref<FormNode>(blankState('GeneralMiscCommunications'));
const busy = ref(false), error = ref(''), notice = ref('');
const errors = ref<SchemaIssue[]>([]), inputErrors = ref<Record<string,string>>({});
const className = computed(() => generalBinding(type.value).className);
const dirty = computed(() => JSON.stringify(toInstance(node.value)) !== JSON.stringify(draft.value?.value));
const endpoint = '/api/admin/general-messages';
function fresh() {
  draft.value = null; inputErrors.value = {}; errors.value = [];
  node.value = newGeneralState(type.value);
}
function accept(value: GeneralMessage) {
  draft.value = value; issueNo.value = value.ob_issue_no; type.value = value.type;
  node.value = toFormState(value.class_name,value.value).state; inputErrors.value = {};
}
function invalid(path: string, message: string) {
  if (message) inputErrors.value[path] = message;
  else for (const key of Object.keys(inputErrors.value)) if (key === path || key.startsWith(`${path}.`) || key.startsWith(`${path}[`)) delete inputErrors.value[key];
}
// `working` shows an immediate status line, so a slow answer never looks like a dead button.
async function perform(work: () => Promise<void>, working = '') {
  busy.value = true; error.value = ''; notice.value = working; errors.value = [];
  try { await work(); }
  catch(e) { notice.value = ''; error.value = e instanceof Error ? e.message : 'General-message request failed'; if(e instanceof ApiError) errors.value = e.errors; }
  finally { busy.value = false; }
}
async function reload() { drafts.value = (await api<{drafts:GeneralMessage[]}>(endpoint)).drafts.filter(item => item.type !== 'annexes'); }
async function save() {
  await perform(async () => {
    if(Object.keys(inputErrors.value).length) throw new Error('Resolve invalid fields before saving.');
    const value = { ...(toInstance(node.value) as Record<string,unknown>), ob_issue_no: String(issueNo.value) };
    errors.value = validateClass(className.value,value);
    if(errors.value.length) { notice.value = ''; return; }
    const url = draft.value ? `${endpoint}/${draft.value.id}` : endpoint;
    const input = draft.value ? {value,expected_revision:draft.value.revision} : {value,type:type.value,ob_issue_no:issueNo.value};
    accept((await api<{draft:GeneralMessage}>(url,'POST',input)).draft);
    await reload(); notice.value = 'Draft saved. An administrator must approve this revision before publication review.';
  }, 'Saving draft…');
}
async function approve() {
  if(!draft.value) return;
  await perform(async () => {
    accept((await api<{draft:GeneralMessage}>(`${endpoint}/${draft.value!.id}/approve`,'POST',{expected_revision:draft.value!.revision})).draft);
    await reload(); notice.value = 'Approved YAML frozen. Open its review PR before publication.';
  });
}
const existingPath = ref('');
async function importExisting() {
  await perform(async () => {
    accept((await api<{draft:GeneralMessage}>(`${endpoint}/import`,'POST',{ob_issue_no:issueNo.value,path:existingPath.value.trim()})).draft);
    await reload(); notice.value = 'Existing record opened as a draft. Approval will propose a replacement of that file for review.';
  });
}
async function remove() {
  if(!draft.value || !window.confirm(`Delete draft ${draft.value.path}?`)) return;
  await perform(async () => {
    await api(`${endpoint}/${draft.value!.id}/delete`,'POST',{expected_revision:draft.value!.revision});
    fresh(); await reload(); notice.value = 'Draft deleted.';
  });
}
async function openReview() {
  if(!draft.value) return;
  await perform(async () => {
    const result = await api<{pr:{pr_url:string|null}}>(`${endpoint}/${draft.value!.id}/review`,'POST',{expected_revision:draft.value!.revision});
    notice.value = result.pr.pr_url ? `Publication review: ${result.pr.pr_url}` : 'Review request reserved. Retry to obtain the PR link.';
  });
}
fresh(); onMounted(() => perform(reload));
</script>
<template>
  <section class="admin-form" :aria-busy="busy" aria-label="General-message authoring">
    <p class="admin-help">Prepare canonical issue messages using ontology fields. Prose supports plain text and English, French, Spanish, Arabic, Russian and Chinese. Existing rich-text documents are preserved read-only.</p>
    <p class="admin-error" v-if="error" role="alert">{{ error }}</p><p class="admin-status" v-if="notice" role="status">{{ notice }}</p>
    <ul class="admin-error" v-if="errors.length" role="alert"><li v-for="(issue,index) in errors" :key="index">{{ issue.path }}: {{ issue.message }}</li></ul>
    <fieldset class="admin-fieldset" :disabled="busy"><legend>Saved drafts</legend>
      <button class="admin-button" type="button" @click="perform(async () => { await reload(); notice = 'List reloaded.'; }, 'Reloading list…')">Reload list</button>
      <button class="admin-button" v-for="item in drafts" :key="item.id" type="button" @click="accept(item)">{{ item.path }} · r{{ item.revision }}{{ item.approved_at ? ' · approved' : '' }}</button>
      <button class="admin-button" type="button" @click="fresh(); notice = 'Started a new message.'">New message</button>
    </fieldset>
    <fieldset class="admin-fieldset" :disabled="busy"><legend>Open an existing record</legend>
      <label class="admin-field admin-label">Repository path <input class="admin-control" v-model="existingPath" placeholder="ob-issues/1331/misc_communications/001.yaml" /></label>
      <button class="admin-button" type="button" :disabled="!existingPath.trim()" @click="importExisting">Open existing record</button>
    </fieldset>
    <fieldset class="admin-fieldset" :disabled="busy"><legend>{{ draft ? 'Edit saved message' : 'New message' }}</legend>
      <label class="admin-field admin-label">Issue number <input class="admin-control" v-model.number="issueNo" type="number" min="1" max="99999" :disabled="!!draft" /></label>
      <label class="admin-field admin-label">Message type <select class="admin-control" v-model="type" :disabled="!!draft" @change="fresh"><option v-for="choice in GENERAL_TYPES" :key="choice" >{{ choice }}</option></select></label>
      <details>
        <summary>Authoring help</summary>
        <p class="admin-help" v-if="type === 'sanc'">For SANC notices, enter the country and SANC code in each typed item row. Existing legacy prose or rich content stays preserved in its original field; rich text is read-only.</p>
        <p class="admin-help" v-else-if="type === 'telephone_service' || type === 'telephone_service_2'">For telephone notices, add a section for each country or area, include its international phone code and contact, then add communications with their publication dates.</p>
        <p class="admin-help" v-else>Use the structured fields for the message. Existing rich-text content is preserved read-only; plain prose can be entered in English, French, Spanish, Arabic, Russian and Chinese.</p>
      </details>
      <SchemaNode :node="node" path="message" :translation="translation" :opaque-readonly="true" :prose="true" @change="node=$event" @invalid="invalid" />
      <button class="admin-button admin-button-primary" type="button" @click="save">Save draft</button>
      <button class="admin-button" type="button" :disabled="!draft || dirty || !!draft.approved_at" @click="approve">Approve saved revision (administrator)</button>
      <button class="admin-button" type="button" :disabled="!draft || !!draft.approved_at" @click="remove">Delete draft</button>
      <button class="admin-button" type="button" :disabled="!draft?.approved_at || dirty" @click="openReview">Open publication review PR (administrator)</button>
    </fieldset>
    <p class="admin-help" v-if="draft">{{ draft.path }} · revision {{ draft.revision }} · {{ draft.approved_at ? 'Approved; publication still requires a reviewed and merged PR.' : 'Awaiting administrator approval.' }}</p>
    <p class="admin-help" v-if="dirty && draft">Unsaved changes. Saving creates a new revision and clears approval.</p>
    <details v-if="draft?.content_yaml"><summary>Exact approved YAML artifact</summary><pre>{{ draft.content_yaml }}</pre></details>
    <p class="admin-help">Paths are assigned by the server. Existing canonical repository files must pass a collision check before a review PR can open.</p>
  </section>
</template>
