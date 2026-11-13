<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { api, ApiError } from '../../lib/admin-client';
import { toFormState, toInstance, type FormNode } from '../../lib/form/model';
import { validateClass, type SchemaIssue } from '../../lib/schema.validators.generated';
import type { EditionMetadata } from '../../../worker/lib/edition-metadata';
import SchemaNode from './SchemaNode.vue';

const props = defineProps<{ issueNo: number }>();
const emit = defineEmits<{ saved: [draft: EditionMetadata] }>();
const draft = ref<EditionMetadata | null>(null);
const node = ref<FormNode>(toFormState('IssueMetadata', { id: props.issueNo }).state);
const busy = ref(false), loaded = ref(false), error = ref(''), notice = ref('');
const errors = ref<SchemaIssue[]>([]), inputErrors = ref<Record<string, string>>({});
const endpoint = computed(() => `/api/admin/composer/editions/${props.issueNo}/metadata`);
const dirty = computed(() => JSON.stringify(toInstance(node.value)) !== JSON.stringify(draft.value?.metadata ?? { id: props.issueNo }));
function invalid(path: string, message: string) {
  if (message) inputErrors.value[path] = message;
  else for (const k of Object.keys(inputErrors.value)) if (k === path || k.startsWith(`${path}.`) || k.startsWith(`${path}[`)) delete inputErrors.value[k];
}
async function perform(work: () => Promise<void>) {
  busy.value = true; error.value = ''; notice.value = ''; errors.value = [];
  try { await work(); } catch (e) { error.value = e instanceof Error ? e.message : 'Metadata request failed'; if (e instanceof ApiError) errors.value = e.errors; }
  finally { busy.value = false; }
}
function accept(value: EditionMetadata) {
  draft.value = value; node.value = toFormState('IssueMetadata', value.metadata).state; inputErrors.value = {};
  emit('saved', value);
}
async function load() {
  const issue = props.issueNo;
  loaded.value = false;
  await perform(async () => {
    const result = await api<{ draft: EditionMetadata | null }>(endpoint.value);
    if (props.issueNo !== issue) return;
    draft.value = result.draft;
    node.value = toFormState('IssueMetadata', result.draft?.metadata ?? { id: issue }).state;
    inputErrors.value = {}; loaded.value = true;
    if (result.draft) emit('saved', result.draft);
  });
}
async function save() {
  const issue = props.issueNo;
  await perform(async () => {
    if (Object.keys(inputErrors.value).length) throw new Error('Resolve invalid fields before saving.');
    const metadata = toInstance(node.value);
    errors.value = validateClass('IssueMetadata', metadata);
    if (errors.value.length) return;
    const result = await api<{ draft: EditionMetadata }>(endpoint.value, 'POST', { metadata, expected_revision: draft.value?.revision ?? 0 });
    if (props.issueNo !== issue) return;
    accept(result.draft); notice.value = 'Metadata draft saved. Schedule the saved dates when ready.';
  });
}
async function schedule() {
  const issue = props.issueNo;
  await perform(async () => {
    const result = await api<{ draft: EditionMetadata }>(`${endpoint.value}/schedule`, 'POST', { expected_revision: draft.value?.revision });
    if (props.issueNo !== issue) return;
    accept(result.draft); notice.value = 'Issue dates scheduled locally. The metadata still requires a reviewed and merged publication request.';
  });
}
watch(() => props.issueNo, load, { immediate: true });
</script>
<template>
  <section :aria-busy="busy" aria-label="Edition metadata">
    <h3>Issue {{ issueNo }} metadata and dates</h3>
    <p>Enter publication_date and cutoff_date as YYYY-MM-DD. Cutoff must be on or before publication. Scheduling requires an ITU administrator.</p>
    <p v-if="error" role="alert">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
    <ul v-if="errors.length" role="alert"><li v-for="(issue, index) in errors" :key="index">{{ issue.path }}: {{ issue.message }}</li></ul>
    <fieldset :disabled="busy || !loaded"><legend>Issue metadata draft</legend>
      <SchemaNode :node="node" path="metadata" @change="node = $event" @invalid="invalid" />
      <button type="button" @click="save">Save metadata</button>
      <button type="button" :disabled="!draft || dirty || !!draft.scheduled_at" @click="schedule">Schedule saved dates</button>
    </fieldset>
    <button type="button" :disabled="busy" @click="load">Reload saved metadata</button>
    <p v-if="draft">Revision {{ draft.revision }} · {{ draft.scheduled_at ? 'Dates scheduled; publication review remains required.' : 'Draft dates are not scheduled.' }}</p>
    <p v-if="dirty">Unsaved changes. Save before scheduling.</p>
  </section>
</template>
