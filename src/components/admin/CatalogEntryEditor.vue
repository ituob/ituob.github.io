<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api, ApiError } from '../../lib/admin-client';
import { SUPPORTED_LANGUAGES } from '../../lib/catalogs';
import { validateCatalogEntry, type CatalogContext, type CatalogIssue } from '../../lib/form/catalog-entry';

interface Register { id: string; slug: string | null; title: Record<string, string>; url: string | null; recommendation: string | null; classification: string | null }
interface Recommendation { code: string; title: Record<string, string> }

const endpoint = '/api/admin/catalog';
const registers = ref<Register[]>([]), recommendations = ref<Recommendation[]>([]);
const editing = ref<string | null>(null); // register id being edited; null = creating
const id = ref(''), url = ref(''), recommendation = ref(''), keyField = ref('');
const title = ref<Record<string, string>>({ en: '' });
const busy = ref(false), error = ref(''), notice = ref(''), serverIssues = ref<CatalogIssue[]>([]);

const context = computed<CatalogContext>(() => ({
  existingIds: registers.value.map(r => r.id),
  existingSlugs: registers.value.flatMap(r => r.slug ? [r.slug] : []),
  recommendations: recommendations.value.map(r => r.code),
}));
const input = computed(() => ({ id: id.value, title: title.value, url: url.value, recommendation: recommendation.value, ...(editing.value === null ? { key_field: keyField.value } : {}) }));
// The same validator the Worker runs: the button stays disabled while any issue remains.
const issues = computed(() => validateCatalogEntry(input.value, context.value, editing.value ?? undefined));
const touched = ref(false);
const shown = computed(() => touched.value ? issues.value : []);
const messages = (path: string) => [...shown.value, ...serverIssues.value].filter(i => i.path === path || i.path.startsWith(`${path}.`)).map(i => i.message);

function fresh() {
  editing.value = null; id.value = ''; url.value = ''; recommendation.value = ''; keyField.value = '';
  title.value = { en: '' }; touched.value = false; serverIssues.value = []; error.value = ''; notice.value = '';
}
function edit(r: Register) {
  fresh(); editing.value = r.id; id.value = r.id; url.value = r.url ?? ''; recommendation.value = r.recommendation ?? '';
  title.value = { en: '', ...r.title };
}
async function load() {
  const result = await api<{ registers: Register[]; recommendations: Recommendation[] }>(endpoint);
  registers.value = result.registers; recommendations.value = result.recommendations;
}
async function submit() {
  touched.value = true; serverIssues.value = []; error.value = ''; notice.value = '';
  if (issues.value.length) return;
  busy.value = true;
  try {
    const result = editing.value === null
      ? await api<{ pr: { url: string } }>(`${endpoint}/registers`, 'POST', input.value)
      : await api<{ pr: { url: string } }>(`${endpoint}/registers/${encodeURIComponent(editing.value)}`, 'PUT', input.value);
    notice.value = `Review PR opened: ${result.pr.url}. The change takes effect when it is merged.`;
    editing.value = null; id.value = ''; url.value = ''; recommendation.value = ''; keyField.value = ''; title.value = { en: '' }; touched.value = false;
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Request failed';
    if (e instanceof ApiError) serverIssues.value = e.errors.map(x => ({ path: x.path, code: x.code as CatalogIssue['code'], message: x.message }));
  } finally { busy.value = false; }
}
onMounted(() => { load().catch(e => { error.value = e instanceof Error ? e.message : 'Could not load the catalog'; }); });
</script>

<template>
  <section>
    <p>Create or edit a service publication. The change opens a review pull request against the catalog repository; nothing is published from here.</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="error" role="alert">{{ error }}</p>

    <h2>{{ editing === null ? 'New service publication' : `Edit ${editing}` }}</h2>
    <form @submit.prevent="submit" novalidate>
      <label>Publication identifier
        <input v-model="id" :readonly="editing !== null" :disabled="editing !== null" autocomplete="off" aria-describedby="id-help" @input="touched = true" />
      </label>
      <p id="id-help">{{ editing === null ? 'Use an uppercase English id, e.g. BUREAUFAX. It cannot be changed after it is created.' : 'The id of a service publication cannot be changed after it is created.' }}</p>
      <ul><li v-for="m in messages('id')" :key="m" role="alert">{{ m }}</li></ul>

      <fieldset>
        <legend>Title</legend>
        <label v-for="lang in SUPPORTED_LANGUAGES" :key="lang">{{ lang }}{{ lang === 'en' ? ' (required)' : '' }}
          <input :value="title[lang] ?? ''" @input="title = { ...title, [lang]: ($event.target as HTMLInputElement).value }; touched = true" />
        </label>
        <ul><li v-for="m in messages('title')" :key="m" role="alert">{{ m }}</li></ul>
      </fieldset>

      <label>Authoritative resource URL
        <input v-model="url" type="url" autocomplete="off" @input="touched = true" />
      </label>
      <ul><li v-for="m in messages('url')" :key="m" role="alert">{{ m }}</li></ul>

      <label>Recommendation
        <select v-model="recommendation" @change="touched = true">
          <option value="">Select a recommendation</option>
          <option v-for="r in recommendations" :key="r.code" :value="r.code">{{ r.code }} {{ r.title.en ?? '' }}</option>
        </select>
      </label>
      <ul><li v-for="m in messages('recommendation')" :key="m" role="alert">{{ m }}</li></ul>

      <template v-if="editing === null">
        <label>Identity field of the entries
          <input v-model="keyField" autocomplete="off" @input="touched = true" />
        </label>
        <p>A new publication is textual. A structured register also needs a parser class and renderer in code.</p>
        <ul><li v-for="m in messages('key_field')" :key="m" role="alert">{{ m }}</li></ul>
      </template>

      <button type="submit" :disabled="busy || (touched && issues.length > 0)">{{ editing === null ? 'Open review PR to add' : 'Open review PR to update' }}</button>
      <button v-if="editing !== null" type="button" @click="fresh">Cancel edit</button>
    </form>

    <h2>Existing publications</h2>
    <table>
      <thead><tr><th>Id</th><th>Title</th><th>Recommendation</th><th>URL</th><th></th></tr></thead>
      <tbody>
        <tr v-for="r in registers" :key="r.id">
          <td>{{ r.id }}</td><td>{{ r.title.en }}</td><td>{{ r.recommendation }}</td>
          <td><a v-if="r.url" :href="r.url" rel="noopener noreferrer">{{ r.url }}</a></td>
          <td><button type="button" @click="edit(r)">Edit</button></td>
        </tr>
      </tbody>
    </table>
  </section>
</template>
