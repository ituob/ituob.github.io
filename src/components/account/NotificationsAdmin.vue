<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { api } from "./api";
interface Suppression { email: string; reason: string; first_seen: string; detail: string | null }
interface Stats {
  since: string;
  days: Record<string, Record<string, number>>;
  totals: Record<string, number>;
  suppressions: Record<string, number>;
  recentSuppressions: Suppression[];
  notificationStatus: Record<string, number>;
}
const METRICS = ["sent", "delivered", "bounced", "complained", "failed", "dlq", "skipped_suppressed", "skipped_prefs", "skipped_no_address"];
const stats = ref<Stats | null>(null);
const loading = ref(true);
const error = ref("");
const dayRows = computed(() => Object.keys(stats.value?.days ?? {}).sort().reverse());
const suppressedTotal = computed(() => Object.values(stats.value?.suppressions ?? {}).reduce((a, b) => a + b, 0));
const n = (v: number | undefined) => v ?? 0;
async function load() {
  loading.value = true;
  error.value = "";
  try { stats.value = await api<Stats>("/api/admin/notifications/stats"); }
  catch (e) { error.value = e instanceof Error ? e.message : "Could not load notification statistics."; }
  finally { loading.value = false; }
}
onMounted(load);
</script>

<template>
  <section aria-labelledby="notifications-heading">
    <h1 id="notifications-heading">Email delivery</h1>
    <p><a href="/admin/">Administration</a> · <button type="button" :disabled="loading" @click="load">Refresh</button></p>
    <p v-if="loading" role="status">Loading statistics…</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <template v-if="stats">
      <h2>Last 14 days (since {{ stats.since }})</h2>
      <dl data-testid="totals">
        <template v-for="m in METRICS" :key="m"><dt>{{ m }}</dt><dd :data-metric="m">{{ n(stats.totals[m]) }}</dd></template>
      </dl>
      <h2>By day</h2>
      <p v-if="!dayRows.length">No email activity in this period.</p>
      <table v-else>
        <thead><tr><th scope="col">Day</th><th v-for="m in METRICS" :key="m" scope="col">{{ m }}</th></tr></thead>
        <tbody>
          <tr v-for="d in dayRows" :key="d"><th scope="row">{{ d }}</th><td v-for="m in METRICS" :key="m">{{ n(stats.days[d]?.[m]) }}</td></tr>
        </tbody>
      </table>
      <h2>Suppressed addresses ({{ suppressedTotal }})</h2>
      <p data-testid="suppression-counts">Hard bounces: {{ n(stats.suppressions.hard_bounce) }} · Complaints: {{ n(stats.suppressions.complaint) }} · Manual: {{ n(stats.suppressions.manual) }}</p>
      <p v-if="!stats.recentSuppressions.length">No addresses are suppressed.</p>
      <table v-else>
        <caption>Most recent suppressions (up to 20)</caption>
        <thead><tr><th scope="col">Address</th><th scope="col">Reason</th><th scope="col">First seen</th><th scope="col">Detail</th></tr></thead>
        <tbody>
          <tr v-for="s in stats.recentSuppressions" :key="s.email"><td>{{ s.email }}</td><td>{{ s.reason }}</td><td>{{ s.first_seen }}</td><td>{{ s.detail }}</td></tr>
        </tbody>
      </table>
      <h2>Notifications by email status</h2>
      <ul><li v-for="(count, status) in stats.notificationStatus" :key="status">{{ status }}: {{ count }}</li></ul>
    </template>
  </section>
</template>
