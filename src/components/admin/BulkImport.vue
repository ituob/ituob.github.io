<script setup lang="ts">
import { computed, ref } from 'vue';
import { api, ApiError, payloadErrors } from '../../lib/admin-client';
import { parseYaml } from '../../lib/form/yaml-io';
import { planImport, type ImportPlan } from '../../lib/form/bulk-import';
const props = defineProps<{ registers: { register_id: string; slug: string; label: string }[] }>();
const registerId = ref(props.registers[0]?.register_id ?? ''), text = ref('');
const plan = ref<ImportPlan | null>(null), problems = ref<string[]>([]), busy = ref(false), error = ref('');
const results = ref<{ index: number; ok: boolean; message: string }[]>([]);
const register = computed(() => props.registers.find(r => r.register_id === registerId.value));
const submittable = computed(() => !!plan.value && !plan.value.blocked && plan.value.actions.length > 0 && !problems.value.length);
async function preview() {
  busy.value = true; error.value = ''; results.value = []; plan.value = null; problems.value = [];
  try {
    const response = await fetch(`/admin/bulk-state/${encodeURIComponent(register.value?.slug ?? '')}.json`);
    if (!response.ok) throw new Error('Current register state is unavailable.');
    const current = (await response.json()).entries as Record<string, unknown>[];
    let imported: unknown;
    try { imported = parseYaml(text.value); } catch (e) { throw new Error(`The list is not valid YAML or JSON: ${e instanceof Error ? e.message : e}`); }
    const next = planImport(registerId.value, current, imported);
    next.actions.forEach((action, i) => { for (const issue of payloadErrors({ type: action.type, data: action.data })) problems.value.push(`Action ${i + 1} ${action.type}: ${issue.path}: ${issue.message}`); });
    plan.value = next;
  } catch (e) { error.value = e instanceof Error ? e.message : 'Preview failed'; }
  finally { busy.value = false; }
}
async function createDrafts() {
  if (!plan.value || !submittable.value || !register.value) return;
  busy.value = true; error.value = ''; results.value = [];
  const { slug } = register.value;
  for (const [index, action] of plan.value.actions.entries()) {
    try {
      await api('/api/me/submissions', 'POST', { register_id: registerId.value, slug, action_type: action.type, payload: { type: action.type, data: action.data } });
      results.value.push({ index, ok: true, message: 'Draft proposal created.' });
    } catch (e) {
      results.value.push({ index, ok: false, message: (e instanceof ApiError && e.errors.length ? e.errors.map(i => `${i.path}: ${i.message}`).join('; ') : '') || (e instanceof Error ? e.message : 'Request failed') });
    }
  }
  busy.value = false;
}
</script>
<template>
  <section :aria-busy="busy" aria-label="Bulk import">
    <p>Paste a complete external list (YAML or JSON rows). It is compared with the register's current state and becomes a series of draft patch proposals that go through review like any other change. Nothing is written as register state.</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <fieldset :disabled="busy"><legend>Import list</legend>
      <label>Register <select v-model="registerId"><option v-for="r in registers" :key="r.register_id" :value="r.register_id">{{ r.label }}</option></select></label>
      <label>Rows <textarea v-model="text" rows="12" spellcheck="false"></textarea></label>
      <button type="button" :disabled="!text.trim()" @click="preview">Preview patch series</button>
    </fieldset>
    <section v-if="plan" aria-label="Preview">
      <h2>Preview</h2>
      <ul v-if="plan.errors.length" role="alert"><li v-for="(e, i) in plan.errors" :key="i">{{ e.row === null ? '' : `Row ${e.row + 1}: ` }}{{ e.message }}</li></ul>
      <ul v-if="problems.length" role="alert"><li v-for="(p, i) in problems" :key="i">{{ p }}</li></ul>
      <p v-if="plan.blocked" role="alert">{{ plan.blocked }}</p>
      <p v-if="!plan.errors.length">{{ plan.added }} added · {{ plan.replaced }} replaced · {{ plan.superseded }} superseded · {{ plan.unchanged }} unchanged · {{ plan.actions.length }} proposals</p>
      <ol><li v-for="(a, i) in plan.actions" :key="i">{{ a.type }} · {{ a.data.entries.length }} entries</li></ol>
      <button type="button" :disabled="busy || !submittable" @click="createDrafts">Create {{ plan.actions.length }} draft proposals</button>
    </section>
    <ul v-if="results.length" aria-label="Results"><li v-for="r in results" :key="r.index" :role="r.ok ? 'status' : 'alert'">Proposal {{ r.index + 1 }}: {{ r.message }}</li></ul>
    <p v-if="results.some(r => r.ok)"><a href="/me/submissions/">Review and submit your drafts</a></p>
  </section>
</template>
