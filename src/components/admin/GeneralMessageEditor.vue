<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api, ApiError } from '../../lib/admin-client';
import { GENERAL_TYPES, generalBinding } from '../../lib/form/general';
import { blankState, setField, toFormState, toInstance, type FormNode } from '../../lib/form/model';
import { validateClass, type SchemaIssue } from '../../lib/schema.validators.generated';
import type { GeneralMessage } from '../../../worker/lib/general-messages';
import SchemaNode from './SchemaNode.vue';

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
  node.value = setField(blankState(className.value),'type',{kind:'leaf',type:'String',value:type.value});
}
function accept(value: GeneralMessage) {
  draft.value = value; issueNo.value = value.ob_issue_no; type.value = value.type;
  node.value = toFormState(value.class_name,value.value).state; inputErrors.value = {};
}
function invalid(path: string, message: string) {
  if (message) inputErrors.value[path] = message;
  else for (const key of Object.keys(inputErrors.value)) if (key === path || key.startsWith(`${path}.`) || key.startsWith(`${path}[`)) delete inputErrors.value[key];
}
async function perform(work: () => Promise<void>) {
  busy.value = true; error.value = ''; notice.value = ''; errors.value = [];
  try { await work(); }
  catch(e) { error.value = e instanceof Error ? e.message : 'General-message request failed'; if(e instanceof ApiError) errors.value = e.errors; }
  finally { busy.value = false; }
}
async function reload() { drafts.value = (await api<{drafts:GeneralMessage[]}>(endpoint)).drafts; }
async function save() {
  await perform(async () => {
    if(Object.keys(inputErrors.value).length) throw new Error('Resolve invalid fields before saving.');
    const value = { ...(toInstance(node.value) as Record<string,unknown>), ob_issue_no: String(issueNo.value) };
    errors.value = validateClass(className.value,value);
    if(errors.value.length) return;
    const url = draft.value ? `${endpoint}/${draft.value.id}` : endpoint;
    const input = draft.value ? {value,expected_revision:draft.value.revision} : {value,type:type.value,ob_issue_no:issueNo.value};
    accept((await api<{draft:GeneralMessage}>(url,'POST',input)).draft);
    await reload(); notice.value = 'Draft saved. An administrator must approve this revision before publication review.';
  });
}
async function approve() {
  if(!draft.value) return;
  await perform(async () => {
    accept((await api<{draft:GeneralMessage}>(`${endpoint}/${draft.value!.id}/approve`,'POST',{expected_revision:draft.value!.revision})).draft);
    await reload(); notice.value = 'Approved YAML frozen. Open its review PR before publication.';
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
  <section :aria-busy="busy" aria-label="General-message authoring">
    <p>Prepare canonical issue messages using ontology fields. Plain text is available where the ontology permits strings. Existing opaque multilingual and rich-text objects are preserved read-only; rich-text authoring is not available. Hash-only telephone prose requires ontology and editor work. SANC authoring is unavailable until the corpus and service class dispatch agree.</p>
    <p v-if="error" role="alert">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
    <ul v-if="errors.length" role="alert"><li v-for="(issue,index) in errors" :key="index">{{ issue.path }}: {{ issue.message }}</li></ul>
    <fieldset :disabled="busy"><legend>Saved drafts</legend>
      <button type="button" @click="perform(reload)">Reload list</button>
      <button v-for="item in drafts" :key="item.id" type="button" @click="accept(item)">{{ item.path }} · r{{ item.revision }}{{ item.approved_at ? ' · approved' : '' }}</button>
      <button type="button" @click="fresh">New message</button>
    </fieldset>
    <fieldset :disabled="busy"><legend>{{ draft ? 'Edit saved message' : 'New message' }}</legend>
      <label>Issue number <input v-model.number="issueNo" type="number" min="1" max="99999" :disabled="!!draft" /></label>
      <label>Message type <select v-model="type" :disabled="!!draft" @change="fresh"><option v-for="choice in GENERAL_TYPES" :key="choice" :disabled="choice === 'sanc'">{{ choice }}{{ choice === 'sanc' ? ' (model mismatch; unavailable)' : '' }}</option></select></label>
      <SchemaNode :node="node" path="message" :opaque-readonly="true" @change="node=$event" @invalid="invalid" />
      <button type="button" @click="save">Save draft</button>
      <button type="button" :disabled="!draft || dirty || !!draft.approved_at" @click="approve">Approve saved revision (administrator)</button>
      <button type="button" :disabled="!draft?.approved_at || dirty" @click="openReview">Open publication review PR (administrator)</button>
    </fieldset>
    <p v-if="draft">{{ draft.path }} · revision {{ draft.revision }} · {{ draft.approved_at ? 'Approved; publication still requires a reviewed and merged PR.' : 'Awaiting administrator approval.' }}</p>
    <p v-if="dirty && draft">Unsaved changes. Saving creates a new revision and clears approval.</p>
    <details v-if="draft?.content_yaml"><summary>Exact approved YAML artifact</summary><pre>{{ draft.content_yaml }}</pre></details>
    <p>Paths are assigned by the server. Existing canonical repository files must pass a collision check before a review PR can open.</p>
  </section>
</template>
