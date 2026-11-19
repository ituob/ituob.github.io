<script setup lang="ts">
import '../../styles/admin-forms.css';
import { computed, onMounted, ref } from 'vue';
import { parseYaml } from '../../lib/form/yaml-io';
import { currentItemDiffs, submissionFieldDiff, type CurrentRegisterItems } from '../../lib/submission-diff';
import { blankState, toFormState, type FormNode } from '../../lib/form/model';
import { actionPayload, actionTypes, amendmentClasses, api, ApiError, payloadErrors, revisionErrors } from '../../lib/admin-client';
import type { SchemaIssue } from '../../lib/schema.validators.generated';
import { duplicateOfToSend, loadDuplicateDraft, type DuplicateSource } from '../../lib/form/duplicate';
import SchemaNode from './SchemaNode.vue';
import AmendmentHeader from './AmendmentHeader.vue';
import { freshPrefill, NO_PREFILL, prefillDay, type PrefillState, type PublicationSource } from '../../lib/form/amendment-header';
import { demoMode } from '../../lib/demo-refusal';
const props = withDefaults(defineProps<{ admin?: boolean; create?: boolean; translation?: boolean; registers?: { register_id: string; slug: string; label: string; source?: PublicationSource }[] }>(), { registers: () => [] });
interface Submission { id: string; register_id: string; slug: string; action_type: string; state: string; current_rev: number; affiliation_kind?: string; affiliation_member_id?: string | null; affiliation_member_name?: string | null }
interface Revision { rev: number; payload_yaml: string; validation: string; created_at: string }
interface Detail { ok: true; submission: Submission; revisions: Revision[]; current?: CurrentRegisterItems; history: { from_state: string; to_state: string; reason: string | null; at: string }[]; pr: { pr_number: number | null; pr_state: string; last_error: string | null } | null }
const rows = ref<Submission[]>([]), detail = ref<Detail | null>(null);
const reviewIds = ref<string[]>([]);
const reviewResults = ref<{ id: string; success: boolean; message: string }[]>([]);
const reviewCount = computed(() => props.admin ? rows.value.filter(row => row.state === 'submitted' && reviewIds.value.includes(row.id)).length : 0);
const selected = ref(''), registerId = ref(''), slug = ref(''), action = ref(actionTypes[0] ?? 'ADD'), className = ref(amendmentClasses[0] ?? 'TextAmendment');
const node = ref<FormNode>(blankState(className.value));
const existing = ref<Record<string, unknown>>({});
// The annexed position offered for the chosen register, and the value last prefilled (replaceable until the author edits it).
let prefill: PrefillState = NO_PREFILL;
function prefillFrom(day: string) { const r = prefillDay(prefill, node.value, day); prefill = r.state; node.value = r.node; }
function freshNode() { const r = freshPrefill(prefill, blankState(className.value)); prefill = r.state; node.value = r.node; }
const inputErrors = ref<Record<string, string>>({});
function invalid(path: string, message: string) { if (message) inputErrors.value[path] = message; else for (const key of Object.keys(inputErrors.value)) if (key === path || key.startsWith(`${path}.`) || key.startsWith(`${path}[`)) delete inputErrors.value[key]; }
const busy = ref(false), error = ref(''), notice = ref(''), errors = ref<SchemaIssue[]>([]);
const reason = ref(''), edition = ref<number | null>(null), override = ref(false), filter = ref('');
const creating = ref(props.create), correctsId = ref(''), duplicateSource = ref<DuplicateSource | null>(null);
const prefix = computed(() => props.admin ? '/api/admin/submissions' : '/api/me/submissions');
const editable = computed(() => creating.value || (!props.admin && ['draft', 'changes_requested'].includes(detail.value?.submission.state ?? '')));
function revisionChanges(revision: Revision) {
  const revisions = detail.value?.revisions ?? [];
  const index = revisions.findIndex(item => item.rev === revision.rev);
  if (index < 0) return [];
  const before = index === 0 ? undefined : parseYaml(revisions[index - 1]!.payload_yaml);
  const after = parseYaml(revision.payload_yaml);
  return submissionFieldDiff(before, after);
}
const currentDiffs = computed(() => detail.value ? currentItemDiffs(detail.value.submission.action_type, existing.value, detail.value.current) : null);
// `working` shows an immediate status line, so a slow answer never looks like a dead button.
async function perform(work: () => Promise<void>, working = '') {
  busy.value = true; error.value = ''; notice.value = working; errors.value = [];
  try { await work(); } catch (e) { notice.value = ''; error.value = e instanceof Error ? e.message : 'Request failed'; if (e instanceof ApiError) errors.value = e.errors; }
  finally { busy.value = false; }
}
async function list() {
  const result = await api<{ submissions: Submission[] }>(`${prefix.value}${filter.value ? `?state=${encodeURIComponent(filter.value)}` : ''}`);
  rows.value = result.submissions;
  reviewIds.value = reviewIds.value.filter(id => props.admin && rows.value.some(row => row.id === id && row.state === 'submitted'));
}
async function startSelectedReviews() {
  if (!props.admin || busy.value || !reviewCount.value) return;
  await perform(async () => {
    reviewResults.value = [];
    // Refresh eligibility before sending; the server still authorizes every transition.
    await list();
    const ids = [...new Set(reviewIds.value)];
    for (const id of ids) {
      if (!props.admin || !reviewIds.value.includes(id) || !rows.value.some(row => row.id === id && row.state === 'submitted')) continue;
      try {
        await api(`/api/admin/submissions/${encodeURIComponent(id)}/start-review`, 'POST', {});
        rows.value = rows.value.map(row => row.id === id ? { ...row, state: 'in_review' } : row);
        reviewIds.value = reviewIds.value.filter(value => value !== id);
        reviewResults.value.push({ id, success: true, message: 'Review started.' });
      } catch (e) {
        reviewResults.value.push({ id, success: false, message: e instanceof Error ? e.message : 'Request failed' });
      }
    }
    await list();
    if (reviewResults.value.some(result => result.success && result.id === selected.value)) await load(selected.value);
  });
}
async function load(id: string) {
  const result = await api<Detail>(`${prefix.value}/${encodeURIComponent(id)}`);
  const rev = result.revisions.find(r => r.rev === result.submission.current_rev);
  if (!rev) throw new Error('Current revision is missing.');
  const payload = parseYaml(rev.payload_yaml) as Record<string, unknown>;
  const data = payload.data as Record<string, unknown>;
  if (!data || typeof data._class !== 'string' || !amendmentClasses.includes(data._class)) throw new Error('This revision has an unsupported amendment class.');
  existing.value = payload; className.value = data._class; node.value = toFormState(data._class, data).state;
  detail.value = result; selected.value = id; creating.value = false; prefill = NO_PREFILL;
  registerId.value = result.submission.register_id; slug.value = result.submission.slug; action.value = result.submission.action_type;
  errors.value = revisionErrors(rev.validation); inputErrors.value = {};
  reason.value = ''; override.value = false;
  if (typeof window !== 'undefined') window.history.replaceState(null, '', `${window.location.pathname}?id=${encodeURIComponent(id)}`);
}
function start() {
  creating.value = true; detail.value = null; selected.value = ''; existing.value = {}; correctsId.value = ''; duplicateSource.value = null;
  freshNode(); inputErrors.value = {}; errors.value = []; error.value = ''; notice.value = '';
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
    if (localErrors.length) { errors.value = localErrors; throw new Error('Resolve the field errors before saving. Your changes remain in this form.'); }
    let id = selected.value;
    if (creating.value) {
      const duplicateOf = duplicateOfToSend(duplicateSource.value, { register_id: registerId.value, slug: slug.value, action: action.value });
      const result = await api<{ submission: Submission }>('/api/me/submissions', 'POST', { register_id: registerId.value, slug: slug.value, action_type: action.value, payload, ...(correctsId.value ? { corrects_id: correctsId.value } : {}), ...(duplicateOf ? { duplicate_of: duplicateOf } : {}) });
      id = result.submission.id;
    } else if (detail.value?.submission.state === 'changes_requested') {
      await api(`/api/me/submissions/${id}/revise`, 'POST', { payload });
      await load(id); await list(); notice.value = 'Revision submitted for review.'; return;
    } else await api(`/api/me/submissions/${id}`, 'PUT', { payload });
    // Load the durable draft first: a failed submit must still expose its saved id and errors.
    await load(id);
    if (submit) { await api(`/api/me/submissions/${id}/submit`, 'POST', {}); await load(id); }
    await list(); notice.value = submit ? 'Submitted for review.' : 'Draft saved.';
  }, submit ? 'Submitting…' : 'Saving draft…');
}
async function transition(verb: string) {
  await perform(async () => {
    const result = await api<{ pr?: { error?: string }; submission?: Submission }>(`${prefix.value}/${selected.value}/${verb}`, 'POST', { reason: reason.value, target_edition: edition.value, override_self_review: override.value });
    await load(selected.value); await list();
    notice.value = result.pr?.error ? `Approval recorded; publication pending: ${result.pr.error}` : 'Workflow action recorded. See current state and publication status below.';
  });
}
// "Duplicate as new entry": /admin/editor/?register=<slug>&duplicate_of=<key> prefills an ADD from that active entry.
async function startDuplicate(register: string, key: string) {
  const option = props.registers.find(r => r.slug === register);
  if (!option) throw new Error('Unknown register for duplication.');
  const draft = await loadDuplicateDraft(fetch, option, key);
  start();
  registerId.value = option.register_id; slug.value = option.slug; action.value = 'ADD'; duplicateSource.value = { register_id: option.register_id, slug: option.slug, key };
  className.value = draft.amendmentClass; node.value = toFormState(draft.amendmentClass, draft.data).state;
  notice.value = `Prefilled from ${key}. Enter the new entry's key before saving.`;
}
onMounted(() => perform(async () => {
  await list();
  const params = new URLSearchParams(window.location.search);
  const id = params.get('id'), dup = params.get('duplicate_of'), register = params.get('register');
  if (id) await load(id); else if (dup && register && props.create && !props.admin) await startDuplicate(register, dup);
}));
</script>
<template>
  <div class="admin-form workspace" :aria-busy="busy">
    <nav aria-label="Submission workspace"><a href="/me/">My account</a> · <a href="/me/submissions/">My submissions</a><template v-if="admin"> · <a href="/admin/">Administration</a></template></nav>
    <p class="admin-help" v-if="admin && demoMode()">ITU review needs an ITU staff account. Proposals are created from a Member State delegate account.</p>
    <p class="admin-help" v-else-if="admin">ITU review requires an authorized Cloudflare Access identity and an ITU role. Proposals are created through your member session.</p>
    <p class="admin-help" v-else>Proposals require sign-in and verified membership for the countries represented by the entries.</p>
    <p v-if="error" role="alert" class="admin-error">{{ error }}</p><p class="admin-status" v-if="notice" role="status">{{ notice }}</p>
    <ul v-if="errors.length" role="alert" class="admin-error"><li v-for="(issue, i) in errors" :key="i"><strong>{{ issue.path || 'payload' }}</strong>: {{ issue.message }}</li></ul>
    <fieldset class="admin-fieldset" :disabled="busy"><legend>Submissions</legend>
      <label class="admin-field admin-label">State filter <select class="admin-control" v-model="filter" @change="perform(list)"><option value="">All states</option><option v-for="state in ['draft','submitted','in_review','changes_requested','approved','pr_pending','pr_open','ci_failed','merged','published','withdrawn','rejected']" :key="state">{{ state }}</option></select></label>
      <button class="admin-button" @click="perform(async () => { await list(); notice = 'List refreshed.'; }, 'Refreshing list…')">Refresh</button><button class="admin-button" v-if="!admin" @click="start">New proposal</button>
      <button class="admin-button" v-if="admin" :disabled="!reviewCount" @click="startSelectedReviews">Start review for selected ({{ reviewCount }})</button>
      <p class="admin-help" v-if="!rows.length && !busy && !error">No submissions found.</p>
      <ul><li v-for="row in rows" :key="row.id"><label class="admin-field admin-label" v-if="admin && row.state === 'submitted'"><input class="admin-control" v-model="reviewIds" type="checkbox" :value="row.id" />Select {{ row.id }} for review</label><button class="admin-button" @click="perform(() => load(row.id))">{{ row.register_id }} · {{ row.action_type }} · {{ row.state }} · {{ row.id }}<span v-if="row.affiliation_kind === 'member'"> · Member State: {{ row.affiliation_member_name || row.affiliation_member_id }}</span><span v-else-if="row.affiliation_kind === 'itu'"> · ITU</span></button></li></ul>
    </fieldset>
    <section v-if="admin && reviewResults.length" aria-label="Bulk review results" aria-live="polite">
      <h2>Bulk review results</h2>
      <ul><li v-for="result in reviewResults" :key="result.id" :class="{ 'admin-error': !result.success }">{{ result.id }}: {{ result.message }}</li></ul>
    </section>
    <section v-if="creating || detail">
      <h2>{{ creating ? 'New action proposal' : `${detail?.submission.id} — ${detail?.submission.state}` }}</h2>
      <p class="admin-help" v-if="detail?.submission.affiliation_kind">Submitted affiliation: {{ detail.submission.affiliation_kind === 'itu' ? 'ITU' : `Member State: ${detail.submission.affiliation_member_name || detail.submission.affiliation_member_id}` }}</p>
      <p class="admin-help" v-if="detail"><a :href="`/me/discussions/?id=${encodeURIComponent(detail.submission.id)}${admin ? '&review=1' : ''}`">Discussion and review history</a></p>
      <p class="admin-help">This editor authors one action patch. Publication identifiers and edition metadata are assigned at approval.</p>
      <details>
        <summary>Amendment authoring help</summary>
        <p class="admin-help">Choose the amendment class and enter its typed fields and rows. For Q.708 SANC, add the country and SANC code in each structured entry. Existing legacy prose is retained with the proposal when the editor supports it; rich-text content remains read-only.</p>
        <p class="admin-help">ADD and REP need complete entries. MOD carries the changed values and identifying key; SUP and DEL carry the key. Textual amendments are staff-only patches.</p>
      </details>
      <fieldset class="admin-fieldset" :disabled="busy || !creating"><legend>Action identity</legend>
        <label class="admin-field admin-label" v-if="registers.length">Register <select class="admin-control" :value="slug" @change="registerChange"><option value="">Choose a register</option><option v-for="r in registers" :key="r.slug" :value="r.slug">{{ r.label }}</option></select></label>
        <label class="admin-field admin-label">Register identifier <input class="admin-control" v-model="registerId" required pattern="[A-Z0-9_]{1,40}" /></label>
        <label class="admin-field admin-label">Register slug <input class="admin-control" v-model="slug" required pattern="[a-z0-9]+(-[a-z0-9]+)*" /></label>
        <label class="admin-field admin-label">Action <select class="admin-control" v-model="action"><option v-for="type in actionTypes" :key="type">{{ type }}</option></select></label>
        <label class="admin-field admin-label">Amendment class <select class="admin-control" v-model="className" @change="freshNode(); inputErrors = {}"><option v-for="name in amendmentClasses" :key="name">{{ name }}</option></select></label>
        <label class="admin-field admin-label" v-if="creating">Corrects published submission (optional) <input class="admin-control" v-model="correctsId" /></label>
      </fieldset>
      <AmendmentHeader :register-id="registerId" :label="registers.find(r => r.register_id === registerId)?.label" :source="registers.find(r => r.register_id === registerId)?.source" @prefill="day => { if (creating) prefillFrom(day); }" />
      <SchemaNode :node="node" path="data" :readonly="busy || !editable" :translation="translation" @change="node = $event" @invalid="invalid" />
      <fieldset class="admin-fieldset" :disabled="busy"><legend>Workflow</legend>
        <template v-if="editable && !admin">
          <button class="admin-button" v-if="creating || detail?.submission.state === 'draft'" @click="save()">Save draft</button>
          <button class="admin-button admin-button-primary" @click="save(true)">{{ detail?.submission.state === 'changes_requested' ? 'Submit revised proposal' : 'Save and submit' }}</button>
        </template>
        <template v-if="detail && !admin && ['draft','submitted','changes_requested'].includes(detail.submission.state)"><label class="admin-field admin-label">Withdrawal reason <textarea class="admin-control" v-model="reason" /></label><button class="admin-button" @click="transition('withdraw')">Withdraw proposal</button></template>
        <template v-if="detail && admin">
          <label class="admin-field admin-label">Review reason <textarea class="admin-control" v-model="reason" /></label>
          <label class="admin-field admin-label"><input class="admin-control" v-model="override" type="checkbox" />Explicit ITU-admin override for reviewing my own proposal (audited)</label>
          <button class="admin-button" v-if="detail.submission.state === 'submitted'" @click="transition('start-review')">Start review</button>
          <template v-if="detail.submission.state === 'in_review'">
            <button class="admin-button" :disabled="!reason.trim()" @click="transition('request-changes')">Request changes</button><button class="admin-button" :disabled="!reason.trim()" @click="transition('reject')">Reject</button>
            <label class="admin-field admin-label">Target OB edition <input class="admin-control" v-model.number="edition" type="number" min="1" step="1" /></label><button class="admin-button" :disabled="!edition || !Number.isInteger(edition) || edition < 1" @click="transition('approve')">Approve and open patch PR</button>
          </template>
          <button class="admin-button" v-if="['pr_pending','ci_failed'].includes(detail.submission.state)" @click="transition('open-pr')">Retry opening PR</button>
        </template>
      </fieldset>
      <template v-if="detail"><h3>Publication status</h3><p class="admin-help" v-if="detail.pr">PR {{ detail.pr.pr_number ?? 'pending' }} · {{ detail.pr.pr_state }}<span v-if="detail.pr.last_error" class="admin-error"> · {{ detail.pr.last_error }}</span></p><p class="admin-help" v-else>No publication PR yet.</p>
      <h3>Review history</h3><ol><li v-for="(event, i) in detail.history" :key="i">{{ event.at }}: {{ event.from_state || 'new' }} → {{ event.to_state }}<span v-if="event.reason"> — {{ event.reason }}</span></li></ol>
      <section v-if="detail.submission.action_type !== 'ADD'" aria-label="Changes against the current register">
        <h3>Changes against the current register</h3>
        <p class="admin-help" v-if="!currentDiffs">Current register item unavailable; compare with the revision history below. CI replay is authoritative.</p>
        <template v-else>
          <p class="admin-help">Compared with the deployed register snapshot, which may lag the register.</p>
          <div v-for="item in currentDiffs" :key="item.index">
            <h4>Item <code>{{ item.key || `entries[${item.index}]` }}</code><template v-if="item.status !== 'active'"> ({{ item.status === 'lapsed' ? 'lapsed in the register' : 'not found in the register' }})</template></h4>
            <p class="admin-help" v-if="!item.changes.length">No field changes.</p>
            <div v-else class="admin-table-scroll" tabindex="0" role="region" aria-label="Current register field changes"><table class="admin-table"><thead><tr><th scope="col">Field</th><th scope="col">Before (current)</th><th scope="col">After (proposed)</th></tr></thead><tbody><tr v-for="change in item.changes" :key="change.path"><th scope="row"><code>{{ change.path }}</code></th><td><pre>{{ change.before }}</pre></td><td><pre>{{ change.after }}</pre></td></tr></tbody></table></div>
          </div>
        </template>
      </section>
      <h3>Revision history</h3><details v-for="revision in detail.revisions" :key="revision.rev"><summary>Revision {{ revision.rev }} · {{ revision.created_at }}</summary>
        <h4>Field changes {{ revision.rev === detail.revisions[0]?.rev ? '(new proposal)' : `from revision ${revision.rev - 1}` }}</h4>
        <p class="admin-help" v-if="!revisionChanges(revision).length">No field changes.</p>
        <div v-else class="admin-table-scroll" tabindex="0" role="region" aria-label="Revision field changes"><table class="admin-table"><thead><tr><th scope="col">Field</th><th scope="col">Before</th><th scope="col">After</th></tr></thead><tbody><tr v-for="change in revisionChanges(revision)" :key="change.path"><th scope="row"><code>{{ change.path }}</code></th><td><pre>{{ change.before }}</pre></td><td><pre>{{ change.after }}</pre></td></tr></tbody></table></div>
        <details><summary>Raw revision YAML</summary><pre>{{ revision.payload_yaml }}</pre></details>
      </details></template>
    </section>
  </div>
</template>
