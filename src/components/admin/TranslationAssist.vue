<script setup lang="ts">
import { ref } from 'vue';
import { api } from '../../lib/admin-client';
// Suggest-only: the suggestion never reaches the parent until the author presses Apply.
const props = defineProps<{ source: string; from: string; to: string }>();
const emit = defineEmits<{ (e: 'apply', text: string): void }>();
const MAX = 2000;
const busy = ref(false), error = ref(''), suggestion = ref('');
async function suggest() {
  error.value = ''; suggestion.value = '';
  if (!props.source.trim()) { error.value = 'Write the source text first.'; return; }
  if (props.source.length > MAX) { error.value = `The source text must be at most ${MAX} characters.`; return; }
  busy.value = true;
  try {
    const res = await api<{ text: string }>('/api/admin/translate', 'POST', { text: props.source, from: props.from, to: props.to });
    if (typeof res.text !== 'string' || !res.text.trim()) throw new Error('The translation service returned no text.');
    suggestion.value = res.text;
  } catch (e) { error.value = e instanceof Error ? e.message : 'Translation request failed'; }
  finally { busy.value = false; }
}
function apply() { emit('apply', suggestion.value); suggestion.value = ''; }
</script>
<template>
  <div :aria-busy="busy" class="translation-assist">
    <button type="button" :disabled="busy" @click="suggest">Suggest {{ to }} translation (ITU machine translation)</button>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <div v-if="suggestion" role="status">
      <p>Machine suggestion, review before use:</p>
      <blockquote>{{ suggestion }}</blockquote>
      <button type="button" @click="apply">Use this translation</button>
      <button type="button" @click="suggestion = ''">Discard</button>
    </div>
  </div>
</template>
<style scoped>.error { color: #a51b27; } blockquote { margin: .5rem 0; overflow-wrap: anywhere; } button { margin: .25rem; }</style>
