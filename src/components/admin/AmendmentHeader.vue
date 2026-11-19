<script setup lang="ts">
import '../../styles/admin-forms.css';
import { computed, onMounted, ref, watch } from 'vue';
import { amendmentHeader, registerPrefillDay, sourceLines, type PublicationSource } from '../../lib/form/amendment-header';
import type { AnnexIndexEntry } from '../../lib/form/annexes';
// Shows what the amended publication was last annexed at; offers its position as the position_on prefill.
const props = defineProps<{ registerId: string; label?: string; source?: PublicationSource | null }>();
const emit = defineEmits<{ (e: 'prefill', position: string): void }>();
const index = ref<AnnexIndexEntry[] | null>(null), failed = ref(false);
const lines = computed(() => sourceLines(props.source));
const header = computed(() => index.value && props.registerId ? amendmentHeader(index.value, props.registerId) : null);
function prefill() { if (!props.registerId || header.value) emit('prefill', registerPrefillDay(header.value)); }
onMounted(async () => {
  try { index.value = await (await fetch('/annex-index.json')).json(); } catch { failed.value = true; }
});
watch(() => [props.registerId, index.value] as const, prefill);
</script>
<template>
  <div class="admin-form amendment-header" v-if="registerId" aria-label="Amended publication">
    <p class="admin-help" v-if="label">Amending {{ label }}</p>
    <p class="admin-help" v-if="lines.recommendation">{{ lines.recommendation }}</p>
    <p class="admin-help" v-if="lines.url">SP resource: <a :href="lines.url" target="_blank" rel="noopener noreferrer">{{ lines.url }}</a></p>
    <p class="admin-error" v-if="failed" role="alert">The annex index could not be loaded, so the annexed position is unknown.</p>
    <p class="admin-status" v-else-if="header?.kind === 'annexed'" role="status">Amending position of {{ header.positionOn }} annexed to OB {{ header.annexedTo }}.</p>
    <p class="admin-error" v-else-if="header?.kind === 'never'" role="alert">This publication doesn’t seem to have been annexed to an OB.</p>
  </div>
</template>
