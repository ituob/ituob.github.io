<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api, type Identity, type Member, type Membership } from "./api";
const identity = ref<Identity | null>(null);
const members = ref<Member[]>([]);
const memberships = ref<Membership[]>([]);
const memberId = ref("");
const note = ref("");
const loading = ref(true);
const busy = ref(false);
const loaded = ref(false);
const error = ref("");
const message = ref("");
const live = () => memberships.value.some((m) => ["pending", "active"].includes(m.status));
async function load() {
  error.value = "";
  loading.value = true;
  loaded.value = false;
  try {
    identity.value = await api<Identity>("/api/whoami");
    if (identity.value.authenticated) {
      const [roster, own] = await Promise.all([
        api<{ members: Member[] }>("/api/members"),
        api<{ memberships: Membership[] }>("/api/me/membership"),
      ]);
      members.value = roster.members;
      memberships.value = own.memberships;
      loaded.value = true;
    }
  } catch (e) { error.value = e instanceof Error ? e.message : "Could not load membership."; }
  finally { loading.value = false; }
}
async function claim() {
  if (busy.value || !memberId.value || live()) return;
  busy.value = true;
  error.value = "";
  message.value = "";
  try {
    await api("/api/me/membership/claim", { memberId: memberId.value, note: note.value.trim() || null });
    message.value = "Your claim was submitted for ITU verification. Submission rights begin after approval.";
    note.value = "";
    await load();
  } catch (e) { error.value = e instanceof Error ? e.message : "Could not submit the claim."; }
  finally { busy.value = false; }
}
const memberName = (id: string | null) => members.value.find((m) => m.id === id)?.name || id || 'ITU staff';
onMounted(load);
</script>

<template>
  <section aria-labelledby="membership-heading">
    <h1 id="membership-heading">Your membership</h1>
    <p><a href="/me/">Your account</a></p>
    <p v-if="loading" role="status">Loading your membership…</p>
    <p v-if="error" role="alert">{{ error }} <button type="button" :disabled="busy || loading" @click="load">Reload</button></p>
    <p v-if="message" role="status">{{ message }}</p>
    <p v-if="identity && !identity.authenticated"><a href="/auth/login?return_to=%2Fme%2Fmembership%2F">Sign in or register</a> to claim your Member State affiliation.</p>
    <template v-if="identity?.authenticated && loaded">
      <h2>Membership history</h2>
      <p v-if="!memberships.length">You have no membership claims yet.</p>
      <ul v-else class="history">
        <li v-for="membership in memberships" :key="membership.id">
          <strong>{{ memberName(membership.member_id) }}</strong> — {{ membership.status }}
          <p v-if="membership.claim_note">Your note: {{ membership.claim_note }}</p>
          <p v-if="membership.decision_note">ITU decision: {{ membership.decision_note }}</p>
        </li>
      </ul>
      <p v-if="live()">You already have a pending or active membership. Pending claims require ITU verification.</p>
      <form v-else @submit.prevent="claim">
        <h2>Claim a Member State affiliation</h2>
        <p>Choose the administration you represent. ITU will verify your affiliation before granting submission rights.</p>
        <label for="member-state">Member State</label>
        <select id="member-state" v-model="memberId" required :disabled="busy">
          <option disabled value="">Choose a Member State</option>
          <option v-for="member in members" :key="member.id" :value="member.id">{{ member.name }}</option>
        </select>
        <p v-if="!members.length">No active Member States are available. Contact ITU for assistance.</p>
        <label for="claim-note">Affiliation details (optional)</label>
        <textarea id="claim-note" v-model="note" rows="4" maxlength="4000" :disabled="busy" aria-describedby="claim-note-help"></textarea>
        <p id="claim-note-help">Provide your administration and position to help ITU verify your claim.</p>
        <button type="submit" :disabled="busy || !memberId || !members.length">{{ busy ? 'Submitting…' : 'Submit claim for verification' }}</button>
      </form>
    </template>
  </section>
</template>

<style scoped>
form { max-width: 42rem; } label { display: block; font-weight: 600; margin: 1rem 0 .4rem; }
select, textarea { width: 100%; padding: .6rem; border: 1px solid #777; border-radius: .2rem; color: inherit; background: transparent; }
button { cursor: pointer; padding: .5rem .9rem; } button:disabled { cursor: default; opacity: .6; }
.history li { margin-bottom: 1rem; } .history p { margin: .3rem 0; overflow-wrap: anywhere; }
</style>
