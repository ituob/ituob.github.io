<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { api, type Identity, type Member } from "./api";
interface Claim { id: number; user_id: string; email: string | null; member_id: string; status: string; claimed_at: string; claim_note: string | null }
interface ImportResult { dry_run: boolean; added: string[]; changed: string[]; missing: string[] }
const identity = ref<Identity | null>(null);
const claims = ref<Claim[]>([]);
const members = ref<Member[]>([]);
const status = ref("pending");
const notes = ref<Record<number, string>>({});
const busy = ref(false);
const loading = ref(true);
const error = ref("");
const message = ref("");
const userId = ref("");
const staffRoles = ref<string[]>(["itu-editor"]);
const statusMemberId = ref("");
const memberStatus = ref("active");
const roster = ref("");
const preview = ref<ImportResult | null>(null);
const previewText = ref("");
watch(roster, () => { preview.value = null; previewText.value = ""; });
const memberName = (id: string) => members.value.find((m) => m.id === id)?.name || id;
async function loadClaims() {
  const data = await api<{ claims: Claim[] }>(`/api/admin/claims?status=${encodeURIComponent(status.value)}`);
  claims.value = data.claims;
}
async function load() {
  loading.value = true;
  error.value = "";
  try {
    identity.value = await api<Identity>("/api/whoami");
    if (!identity.value.access) return;
    const rosterResult = await api<{ members: Member[] }>("/api/members");
    members.value = rosterResult.members;
    await loadClaims();
  } catch (e) { error.value = e instanceof Error ? e.message : "Could not load administration."; }
  finally { loading.value = false; }
}
async function run(action: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  message.value = "";
  try { await action(); }
  catch (e) { error.value = e instanceof Error ? e.message : "The action failed."; }
  finally { busy.value = false; }
}
function decide(claim: Claim, action: "verify" | "reject" | "deactivate") {
  return run(async () => {
    const path = action === "deactivate" ? `memberships/${claim.id}/deactivate` : `claims/${claim.id}/${action}`;
    await api(`/api/admin/${path}`, { note: notes.value[claim.id]?.trim() || null });
    message.value = action === "verify" ? "Membership verified." : action === "reject" ? "Claim rejected." : "Membership deactivated. Previous contributions remain in the record.";
    await loadClaims();
  });
}
function provision() {
  return run(async () => {
    await api("/api/admin/itu-staff", { userId: userId.value.trim(), roles: staffRoles.value });
    message.value = "ITU staff membership provisioned.";
    userId.value = "";
  });
}
function changeStatus() {
  return run(async () => {
    await api(`/api/admin/members/${encodeURIComponent(statusMemberId.value.trim())}/status`, { status: memberStatus.value });
    message.value = `Member State status updated to ${memberStatus.value}.`;
    members.value = (await api<{ members: Member[] }>("/api/members")).members;
  });
}
function parseRoster() {
  const parsed: unknown = JSON.parse(roster.value);
  if (!Array.isArray(parsed) || !parsed.length) throw new Error("Provide a non-empty JSON array of Member State records.");
  for (const row of parsed) {
    if (!row || typeof row.id !== "string" || !row.id.trim() || typeof row.name !== "string" || !row.name.trim() || typeof row.register_key !== "string" || !row.register_key.trim()) throw new Error("Each Member State requires id, name and register_key strings.");
    if (row.status !== undefined && !["active", "suspended", "withdrawn"].includes(row.status)) throw new Error("Roster status must be active, suspended or withdrawn.");
  }
  return parsed;
}
function importRoster(apply: boolean) {
  return run(async () => {
    if (apply && (!preview.value || previewText.value !== roster.value)) throw new Error("Preview this roster before importing it.");
    const result = await api<ImportResult>(`/api/admin/roster/import${apply ? '' : '?dry_run=1'}`, { members: parseRoster() });
    preview.value = result;
    previewText.value = roster.value;
    message.value = apply ? "Roster imported. Missing Member States were preserved." : "Preview ready. Check the changes before importing.";
    if (apply) {
      preview.value = null;
      members.value = (await api<{ members: Member[] }>("/api/members")).members;
    }
  });
}
async function readRoster(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (file.size > 1024 * 1024) { error.value = "Choose a roster file smaller than 1 MB."; return; }
  try { roster.value = await file.text(); }
  catch { error.value = "Could not read the roster file."; }
}
onMounted(load);
</script>

<template>
  <section aria-labelledby="members-heading">
    <h1 id="members-heading">Membership administration</h1>
    <p><a href="/me/">Your account</a> · <a href="/admin/">Editorial administration</a></p>
    <p v-if="loading" role="status">Loading administration…</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="message" role="status">{{ message }}</p>
    <p v-if="!loading && !identity?.access">A verified Cloudflare Access identity is required. <a href="/admin/members/">Reload after signing in through Access</a>.</p>
    <template v-if="identity?.access">
      <p>Access identity: {{ identity.access.email }}</p>
      <section aria-labelledby="claims-heading">
        <h2 id="claims-heading">Member State claims</h2>
        <form @submit.prevent="run(loadClaims)">
          <label for="claim-status">Show claims</label>
          <select id="claim-status" v-model="status" :disabled="busy">
            <option value="pending">Pending</option><option value="active">Active</option>
            <option value="rejected">Rejected</option><option value="deactivated">Deactivated</option>
          </select>
          <button type="submit" :disabled="busy">Refresh claims</button>
        </form>
        <p v-if="!claims.length && !loading">No claims in this view.</p>
        <article v-for="claim in claims" :key="claim.id" class="claim">
          <h3>{{ memberName(claim.member_id) }} · claim {{ claim.id }}</h3>
          <p>{{ claim.email || claim.user_id }} · {{ claim.status }} · {{ claim.claimed_at }}</p>
          <p>Account ID: {{ claim.user_id }}</p>
          <p v-if="claim.claim_note">Affiliation details: {{ claim.claim_note }}</p>
          <template v-if="claim.status === 'pending' || claim.status === 'active'">
            <label :for="`decision-${claim.id}`">Decision note (optional)</label>
            <textarea :id="`decision-${claim.id}`" v-model="notes[claim.id]" rows="2" maxlength="4000" :disabled="busy"></textarea>
            <div class="actions" v-if="claim.status === 'pending'">
              <button type="button" :disabled="busy" @click="decide(claim, 'verify')">Verify affiliation</button>
              <button type="button" :disabled="busy" @click="decide(claim, 'reject')">Reject claim</button>
            </div>
            <button v-else type="button" :disabled="busy" @click="decide(claim, 'deactivate')">Deactivate membership</button>
          </template>
        </article>
      </section>
      <section aria-labelledby="staff-heading">
        <h2 id="staff-heading">Provision ITU staff</h2>
        <p>The staff member must sign in once, then provide their account ID from their account page.</p>
        <form @submit.prevent="provision">
          <label for="staff-user">Account ID</label><input id="staff-user" v-model="userId" required :disabled="busy" />
          <fieldset :disabled="busy"><legend>Staff roles</legend>
            <label><input v-model="staffRoles" type="checkbox" value="itu-editor" /> ITU editor</label>
            <label><input v-model="staffRoles" type="checkbox" value="itu-admin" /> ITU administrator</label>
          </fieldset>
          <button type="submit" :disabled="busy || !staffRoles.length || !userId.trim()">Provision staff membership</button>
        </form>
      </section>
      <section aria-labelledby="status-heading">
        <h2 id="status-heading">Member State status</h2>
        <p>Suspending or withdrawing a Member State stops new submissions. Historical contributions remain available.</p>
        <form @submit.prevent="changeStatus">
          <label for="status-member">Member State ID</label><input id="status-member" v-model="statusMemberId" list="member-ids" required :disabled="busy" />
          <datalist id="member-ids"><option v-for="member in members" :key="member.id" :value="member.id">{{ member.name }}</option></datalist>
          <label for="member-status">Status</label><select id="member-status" v-model="memberStatus" :disabled="busy"><option value="active">Active</option><option value="suspended">Suspended</option><option value="withdrawn">Withdrawn</option></select>
          <button type="submit" :disabled="busy || !statusMemberId.trim()">Update Member State status</button>
        </form>
      </section>
      <section aria-labelledby="roster-heading">
        <h2 id="roster-heading">Import Member State roster</h2>
        <p>Upload or paste a JSON array with id, name and register_key for each Member State. Optional fields: iso3166_alpha2, itu_identifier, member_since and status.</p>
        <form @submit.prevent="importRoster(false)">
          <label for="roster-file">Roster file</label><input id="roster-file" type="file" accept=".json,application/json" :disabled="busy" @change="readRoster" />
          <label for="roster-json">Roster JSON</label><textarea id="roster-json" v-model="roster" rows="10" required :disabled="busy" spellcheck="false"></textarea>
          <button type="submit" :disabled="busy || !roster.trim()">Preview roster changes</button>
          <div v-if="preview" class="preview">
            <p>Added: {{ preview.added.join(', ') || 'None' }}</p>
            <p>Changed: {{ preview.changed.join(', ') || 'None' }}</p>
            <p>Missing from import (preserved): {{ preview.missing.join(', ') || 'None' }}</p>
            <button type="button" :disabled="busy" @click="importRoster(true)">Import this roster</button>
          </div>
        </form>
      </section>
    </template>
  </section>
</template>

<style scoped>
section section { margin-top: 2.5rem; } form { max-width: 46rem; }
label { display: block; font-weight: 600; margin: .8rem 0 .35rem; }
input:not([type=checkbox]), select, textarea { width: 100%; padding: .6rem; border: 1px solid #777; border-radius: .2rem; color: inherit; background: transparent; }
input[type=checkbox] { margin-right: .4rem; } button { cursor: pointer; padding: .5rem .9rem; margin-top: .7rem; }
button:disabled { cursor: default; opacity: .6; } .claim { padding: 1rem; border: 1px solid #888; margin: 1rem 0; overflow-wrap: anywhere; }
.actions { display: flex; flex-wrap: wrap; gap: .8rem; } .preview { overflow-wrap: anywhere; }
fieldset { margin-top: 1rem; padding: 1rem; }
</style>
