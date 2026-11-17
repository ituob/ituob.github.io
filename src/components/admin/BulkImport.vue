<script setup lang="ts">
import { computed, ref } from 'vue';
import { api, ApiError } from '../../lib/admin-client';
import { parseYaml } from '../../lib/form/yaml-io';
import { planImport, type ImportPlan } from '../../lib/form/bulk-import';
const props = defineProps<{ registers: { register_id: string; slug: string; label: string }[] }>();
const registerId = ref(props.registers[0]?.register_id ?? ''), text = ref('');
const plan = ref<ImportPlan | null>(null), busy = ref(false), error = ref('');
const results = ref<{ index: number; ok: boolean; message: string }[]>([]);
const register = computed(() => props.registers.find(r => r.register_id === registerId.value));
const submittable = computed(() => !!plan.value && !plan.value.blocked && plan.value.actions.length > 0);
async function preview() {
  busy.value = true; error.value = ''; results.value = []; plan.value = null;
  try {
    const response = await fetch(`/admin/bulk-state/${encodeURIComponent(register.value?.slug ?? '')}.json`);
    if (!response.ok) throw new Error('Current register state is unavailable.');
    const current = (await response.json()).entries as Record<string, unknown>[];
    let imported: unknown;
    try { imported = parseYaml(text.value); } catch (e) { throw new Error(`The list is not valid YAML or JSON: ${e instanceof Error ? e.message : e}`); }
    const next = planImport(registerId.value, current, imported);
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
  <section class="admin-form" :aria-busy="busy" aria-label="Bulk import">
    <p class="admin-help">Paste a complete external list (YAML or JSON rows). It is compared with the register's current state and becomes a series of draft patch proposals that go through review like any other change. Nothing is written as register state.</p>
    <p class="admin-error" v-if="error" role="alert">{{ error }}</p>
    <fieldset class="admin-fieldset" :disabled="busy"><legend>Import list</legend>
      <label class="admin-field admin-label">Register <select class="admin-control" v-model="registerId"><option v-for="r in registers" :key="r.register_id" :value="r.register_id">{{ r.label }}</option></select></label>
      <label class="admin-field admin-label">Rows <textarea class="admin-control" v-model="text" rows="12" spellcheck="false"></textarea></label>
      <button class="admin-button admin-button-primary" type="button" :disabled="!text.trim()" @click="preview">Preview patch series</button>
    </fieldset>
    <section v-if="plan" aria-label="Preview">
      <h2>Preview</h2>
      <ul class="admin-error" v-if="plan.errors.length" role="alert"><li v-for="(e, i) in plan.errors" :key="i">{{ e.row === null ? '' : `Row ${e.row + 1}: ` }}{{ e.message }}</li></ul>
      <p class="admin-error" v-if="plan.errors.length" role="alert">{{ plan.errors.length }} {{ plan.errors.length === 1 ? 'problem' : 'problems' }} found. Nothing can be submitted until the list is fixed.</p>
      <p class="admin-error" v-if="plan.blocked" role="alert">{{ plan.blocked }}</p>
      <p class="admin-help" v-if="!plan.errors.length">{{ plan.added }} added · {{ plan.replaced }} replaced · {{ plan.superseded }} superseded · {{ plan.unchanged }} unchanged · {{ plan.actions.length }} proposals</p>
      <ol><li v-for="(a, i) in plan.actions" :key="i">{{ a.type }} · {{ a.data.entries.length }} entries</li></ol>
      <button class="admin-button admin-button-primary" type="button" :disabled="busy || !submittable" @click="createDrafts">Create {{ plan.actions.length }} draft proposals</button>
    </section>
    <ul v-if="results.length" aria-label="Results"><li v-for="r in results" :key="r.index" :role="r.ok ? 'status' : 'alert'" :class="r.ok ? 'admin-status' : 'admin-error'">Proposal {{ r.index + 1 }}: {{ r.message }}</li></ul>
    <p class="admin-help" v-if="results.some(r => r.ok)"><a href="/me/submissions/">Review and submit your drafts</a></p>
  </section>
</template>

<style src="../../styles/admin-forms.css"></style>
