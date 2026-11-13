<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api, type Identity } from "./api";
const identity = ref<Identity | null>(null);
const error = ref("");
const loading = ref(true);
async function load() {
  loading.value = true;
  error.value = "";
  try { identity.value = await api<Identity>("/api/whoami"); }
  catch (e) { error.value = e instanceof Error ? e.message : "Could not load your account."; }
  finally { loading.value = false; }
}
onMounted(load);
</script>

<template>
  <section aria-labelledby="account-heading">
    <h1 id="account-heading">Your account</h1>
    <p v-if="loading" role="status">Loading your account…</p>
    <p v-if="error" role="alert">{{ error }} <button type="button" @click="load">Try again</button></p>
    <template v-if="identity">
      <template v-if="identity.authenticated">
        <p>Signed in as <strong>{{ identity.user?.displayName || identity.user?.email || identity.userId }}</strong>.</p>
        <dl>
          <dt>Account ID</dt><dd>{{ identity.userId }}</dd>
          <dt>Email</dt><dd>{{ identity.user?.email || 'Not provided by the identity service' }}</dd>
          <dt>Roles</dt><dd>{{ identity.roles?.length ? identity.roles.join(', ') : 'No submission roles assigned' }}</dd>
          <dt>Member State</dt><dd>{{ identity.memberStateId || 'No active Member State affiliation' }}</dd>
        </dl>
        <p><a href="/me/membership/">Manage your membership</a></p>
        <form method="post" action="/auth/logout"><button type="submit">Sign out of ituob.org</button></form>
      </template>
      <template v-else>
        <p>Sign in through the identity service to claim a Member State affiliation and participate in submissions.</p>
        <p><a href="/auth/login?return_to=%2Fme%2F">Sign in or register</a></p>
        <p>Account registration, passwords and account recovery are managed by the identity service.</p>
      </template>
      <p v-if="identity.access"><a href="/admin/members/">Membership administration</a> · Access identity: {{ identity.access.email }}</p>
    </template>
  </section>
</template>

<style scoped>
dl { display: grid; grid-template-columns: max-content 1fr; gap: .6rem 1.4rem; }
dt { font-weight: 600; } dd { margin: 0; overflow-wrap: anywhere; }
button { cursor: pointer; padding: .5rem .9rem; }
@media (max-width: 40rem) { dl { grid-template-columns: 1fr; } }
</style>
