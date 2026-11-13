<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { parseYaml } from '../../lib/form/yaml-io';
import { blankState, toFormState, type FormNode } from '../../lib/form/model';
import { actionPayload, actionTypes, amendmentClasses, api, ApiError, payloadErrors, revisionErrors } from '../../lib/admin-client';
import type { SchemaIssue } from '../../lib/schema.validators.generated';
import SchemaNode from './SchemaNode.vue';
const props = withDefaults(defineProps<{ admin?: boolean; create?: boolean; registers?: { register_id: string; slug: string; label: string }[] }>(), { registers: () => [] });
interface Submission { id: string; register_id: string; slug: string; action_type: string; state: string; current_rev: number }
interface Revision { rev: number; payload_yaml: string; validation: string; created_at: string }
interface Detail { ok: true; submission: Submission; revisions: Revision[]; history: { from_state: string; to_state: string; reason: string | null; at: string }[]; pr: { pr_number: number | null; pr_state: string; last_error: string | null } | null }
const rows = ref<Submission[]>([]), detail = ref<Detail | null>(null);
const selected = ref(''), registerId = ref(''), slug = ref(''), action = ref(actionTypes[0] ?? 'ADD'), className = ref(amendmentClasses[0] ?? 'TextAmendment');
const node = ref<FormNode>(blankState(className.value));
const existing = ref<Record<string, unknown>>({});
const inputErrors = ref<Record<string, string>>({});
function invalid(path: string, message: string) { if (message) inputErrors.value[path] = message; else for (const key of Object.keys(inputErrors.value)) if (key === path || key.startsWith(`${path}.`) || key.startsWith(`${path}[`)) delete inputErrors.value[key]; }
const busy = ref(false), error = ref(''), notice = ref(''), errors = ref<SchemaIssue[]>([]);
const reason = ref(''), edition = ref<number | null>(null), override = ref(false), filter = ref('');
const creating = ref(props.create), correctsId = ref('');
const prefix = computed(() => props.admin ? '/api/admin/submissions' : '/api/me/submissions');
const editable = computed(() => creating.value || (!props.admin && ['draft', 'changes_requested'].includes(detail.value?.submission.state ?? '')));
async function perform(work: () => Promise<void>) {
  busy.value = true; error.value = ''; notice.value = ''; errors.value = [];
  try { await work(); } catch (e) { error.value = e instanceof Error ? e.message : 'Request failed'; if (e instanceof ApiError) errors.value = e.errors; }
  finally { busy.value = false; }
}
async function list() { const result = await api<{ submissions: Submission[] }>(`${prefix.value}${filter.value ? `?state=${encodeURIComponent(filter.value)}` : ''}`); rows.value = result.submissions; }
async function load(id: string) {
  const result = await api<Detail>(`${prefix.value}/${encodeURIComponent(id)}`);
  const rev = result.revisions.find(r => r.rev === result.submission.current_rev);
  if (!rev) throw new Error('Current revision is missing.');
  const payload = parseYaml(rev.payload_yaml) as Record<string, unknown>;
  const data = payload.data as Record<string, unknown>;
  if (!data || typeof data._class !== 'string' || !amendmentClasses.includes(data._class)) throw new Error('This revision has an unsupported amendment class.');
  existing.value = payload; className.value = data._class; node.value = toFormState(data._class, data).state;
  detail.value = result; selected.value = id; creating.value = false;
  registerId.value = result.submission.register_id; slug.value = result.submission.slug; action.value = result.submission.action_type;
  errors.value = revisionErrors(rev.validation); inputErrors.value = {};
  reason.value = ''; override.value = false;
  if (typeof window !== 'undefined') window.history.replaceState(null, '', `${window.location.pathname}?id=${encodeURIComponent(id)}`);
}
function start() {
  creating.value = true; detail.value = null; selected.value = ''; existing.value = {}; correctsId.value = '';
  node.value = blankState(className.value); inputErrors.value = {}; errors.value = []; error.value = ''; notice.value = '';
  window.history.replaceState(null, '', window.location.pathname);
}
function registerChange(event: Event) {
  const option = props.registers.find(r => r.slug === (event.target as HTMLSelectElement).value);
  if (option) { registerId.value = option.register_id; slug.value = option.slug; }
}
async function save(submit = false) {
  await perform(async () => {
    if (Object.keys(inputErrors.value).length) throw new Error('Resolve invalid JSON fields before saving.');
    const payload = actionPayload(action.value, node.value, existing.value);
    const localErrors = payloadErrors(payload);
    if (submit && localErrors.length) { errors.value = localErrors; throw new Error('Resolve the field errors before submitting.'); }
    let id = selected.value;
    if (creating.value) {
      const result = await api<{ submission: Submission }>('/api/me/submissions', 'POST', { register_id: registerId.value, slug: slug.value, action_type: action.value, payload, ...(correctsId.value ? { corrects_id: correctsId.value } : {}) });
      id = result.submission.id;
    } else if (detail.value?.submission.state === 'changes_requested') {
      await api(`/api/me/submissions/${id}/revise`, 'POST', { payload });
      await load(id); await list(); notice.value = 'Revision submitted for review.'; return;
    } else await api(`/api/me/submissions/${id}`, 'PUT', { payload });
    // Load the durable draft first: a failed submit must still expose its saved id and errors.
    await load(id);
    if (submit) { await api(`/api/me/submissions/${id}/submit`, 'POST', {}); await load(id); }
    await list(); notice.value = submit ? 'Submitted for review.' : 'Draft saved. Validation errors must be resolved before submission.';
  });
}
async function transition(verb: string) {
  await perform(async () => {
    const result = await api<{ pr?: { error?: string }; submission?: Submission }>(`${prefix.value}/${selected.value}/${verb}`, 'POST', { reason: reason.value, target_edition: edition.value, override_self_review: override.value });
    await load(selected.value); await list();
    notice.value = result.pr?.error ? `Approval recorded; publication pending: ${result.pr.error}` : 'Workflow action recorded. See current state and publication status below.';
  });
}
onMounted(() => perform(async () => { await list(); const id = new URLSearchParams(window.location.search).get('id'); if (id) await load(id); }));
</script>
<template>
  <div class="workspace" :aria-busy="busy">
    <nav aria-label="Submission workspace"><a href="/me/">My account</a> · <a href="/me/submissions/">My submissions</a><template v-if="admin"> · <a href="/admin/">Administration</a></template></nav>
    <p v-if="admin">ITU review requires an authorized Cloudflare Access identity and an ITU role. Proposals are created through your member session.</p>
    <p v-else>Proposals require sign-in and verified membership for the countries represented by the entries.</p>
    <p v-if="error" role="alert" class="error">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
    <ul v-if="errors.length" role="alert" class="error"><li v-for="(issue, i) in errors" :key="i"><strong>{{ issue.path || 'payload' }}</strong>: {{ issue.message }}</li></ul>
    <fieldset :disabled="busy"><legend>Submissions</legend>
      <label>State filter <select v-model="filter" @change="perform(list)"><option value="">All states</option><option v-for="state in ['draft','submitted','in_review','changes_requested','approved','pr_pending','pr_open','ci_failed','merged','published','withdrawn','rejected']" :key="state">{{ state }}</option></select></label>
      <button @click="perform(list)">Refresh</button><button v-if="!admin" @click="start">New proposal</button>
      <p v-if="!rows.length && !busy && !error">No submissions found.</p>
      <ul><li v-for="row in rows" :key="row.id"><button @click="perform(() => load(row.id))">{{ row.register_id }} · {{ row.action_type }} · {{ row.state }} · {{ row.id }}</button></li></ul>
    </fieldset>
    <section v-if="creating || detail">
      <h2>{{ creating ? 'New action proposal' : `${detail?.submission.id} — ${detail?.submission.state}` }}</h2>
      <p>This editor authors one action patch. Publication identifiers and edition metadata are assigned at approval.</p>
      <fieldset :disabled="busy || !creating"><legend>Action identity</legend>
        <label v-if="registers.length">Register <select @change="registerChange"><option value="">Choose a register</option><option v-for="r in registers" :key="r.slug" :value="r.slug">{{ r.label }}</option></select></label>
        <label>Register identifier <input v-model="registerId" required pattern="[A-Z0-9_]{1,40}" /></label>
        <label>Register slug <input v-model="slug" required pattern="[a-z0-9]+(-[a-z0-9]+)*" /></label>
        <label>Action <select v-model="action"><option v-for="type in actionTypes" :key="type">{{ type }}</option></select></label>
        <label>Amendment class <select v-model="className" @change="node = blankState(className); inputErrors = {}"><option v-for="name in amendmentClasses" :key="name">{{ name }}</option></select></label>
        <label v-if="creating">Corrects published submission (optional) <input v-model="correctsId" /></label>
      </fieldset>
      <SchemaNode :node="node" path="data" :readonly="busy || !editable" @change="node = $event" @invalid="invalid" />
      <fieldset :disabled="busy"><legend>Workflow</legend>
        <template v-if="editable && !admin">
          <button v-if="creating || detail?.submission.state === 'draft'" @click="save()">Save draft</button>
          <button @click="save(true)">{{ detail?.submission.state === 'changes_requested' ? 'Submit revised proposal' : 'Save and submit' }}</button>
        </template>
        <template v-if="detail && !admin && ['draft','submitted','changes_requested'].includes(detail.submission.state)"><label>Withdrawal reason <textarea v-model="reason" /></label><button @click="transition('withdraw')">Withdraw proposal</button></template>
        <template v-if="detail && admin">
          <label>Review reason <textarea v-model="reason" /></label>
          <label><input v-model="override" type="checkbox" />Explicit ITU-admin override for reviewing my own proposal (audited)</label>
          <button v-if="detail.submission.state === 'submitted'" @click="transition('start-review')">Start review</button>
          <template v-if="detail.submission.state === 'in_review'">
            <button :disabled="!reason.trim()" @click="transition('request-changes')">Request changes</button><button :disabled="!reason.trim()" @click="transition('reject')">Reject</button>
            <label>Target OB edition <input v-model.number="edition" type="number" min="1" step="1" /></label><button :disabled="!edition || !Number.isInteger(edition) || edition < 1" @click="transition('approve')">Approve and open patch PR</button>
          </template>
          <button v-if="['pr_pending','ci_failed'].includes(detail.submission.state)" @click="transition('open-pr')">Retry opening PR</button>
        </template>
      </fieldset>
      <template v-if="detail"><h3>Publication status</h3><p v-if="detail.pr">PR {{ detail.pr.pr_number ?? 'pending' }} · {{ detail.pr.pr_state }}<span v-if="detail.pr.last_error" class="error"> · {{ detail.pr.last_error }}</span></p><p v-else>No publication PR yet.</p>
      <h3>Review history</h3><ol><li v-for="(event, i) in detail.history" :key="i">{{ event.at }}: {{ event.from_state || 'new' }} → {{ event.to_state }}<span v-if="event.reason"> — {{ event.reason }}</span></li></ol>
      <h3>Revision history</h3><details v-for="revision in detail.revisions" :key="revision.rev"><summary>Revision {{ revision.rev }} · {{ revision.created_at }}</summary><pre>{{ revision.payload_yaml }}</pre></details></template>
    </section>
  </div>
</template>
<style scoped>
.workspace { max-width: 72rem; margin: 2rem auto; } fieldset { border: 1px solid #9baaba; padding: 1rem; margin: 1rem 0; } label { display: block; margin: .75rem 0; } input, select, textarea, button { border: 1px solid #7c8b9c; border-radius: .2rem; padding: .4rem; max-width: 100%; } button { margin: .25rem; cursor: pointer; } textarea { display: block; width: 100%; } button:disabled { opacity: .55; cursor: default; } .error { color: #a51b27; } pre { white-space: pre-wrap; overflow-wrap: anywhere; } :deep(.schema-field) { margin: .75rem 0; padding-left: .75rem; border-left: 2px solid #d5dce3; } :deep(textarea) { display: block; width: 100%; border: 1px solid #7c8b9c; padding: .4rem; } :deep(.field-path) { display: block; font-size: .8rem; }
</style>
