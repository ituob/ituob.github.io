<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, discussionLink, notificationPayload, type Notification } from '../../lib/discussion-client';
const notifications = ref<Notification[]>([]), unread = ref(false), busy = ref(false), loaded = ref(false), error = ref(''), notice = ref('');
const level = ref(''), handle = ref(''), savedHandle = ref<string | null>(null);
async function perform(work: () => Promise<void>) { busy.value = true; error.value = ''; notice.value = ''; try { await work(); } catch (e) { error.value = e instanceof Error ? e.message : 'Request failed'; } finally { busy.value = false; } }
async function refresh() { notifications.value = (await api<{ notifications: Notification[] }>(`/api/me/notifications${unread.value ? '?unread=1' : ''}`)).notifications; loaded.value = true; }
async function markRead(id: string) { await perform(async () => { await api(`/api/me/notifications/${id}/read`, 'POST', {}); await refresh(); notice.value = 'Notification marked as read.'; }); }
async function savePrefs() { await perform(async () => {
  if (!['all', 'mentions', 'none'].includes(level.value)) throw new Error('Choose a notification preference.');
  const result = await api<{ level: string }>('/api/me/notification-prefs', 'PUT', { level: level.value }); level.value = result.level; notice.value = 'Email notification preference saved.';
}); }
async function saveHandle() { await perform(async () => {
  const result = await api<{ handle: string }>('/api/me/handle', 'PUT', { handle: handle.value }); handle.value = result.handle; savedHandle.value = result.handle; notice.value = 'Mention handle saved.';
}); }
onMounted(() => perform(async () => {
  const [prefs, identity] = await Promise.all([api<{ level: string }>('/api/me/notification-prefs'), api<{ handle: string | null }>('/api/me/handle')]);
  level.value = prefs.level; savedHandle.value = identity.handle; handle.value = identity.handle ?? ''; await refresh();
}));
</script>
<template>
  <div class="inbox" :aria-busy="busy">
    <nav><a href="/me/">My account</a> · <a href="/me/submissions/">My submissions</a> · <a href="/me/discussions/">Discussions</a></nav>
    <p v-if="error" role="alert" class="error">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
    <fieldset :disabled="busy"><legend>Inbox</legend><label><input v-model="unread" type="checkbox" @change="perform(refresh)" />Unread only</label><button @click="perform(refresh)">Refresh notifications</button>
      <p v-if="loaded && !notifications.length && !error">No notifications found.</p>
      <ol><li v-for="notification in notifications" :key="notification.id"><article :aria-label="`${notification.kind}, ${notification.read_at ? 'read' : 'unread'}`">
        <p><strong>{{ notification.kind }}</strong> · {{ notification.created_at }} · {{ notification.read_at ? 'Read' : 'Unread' }}</p>
        <p v-if="notificationPayload(notification.payload).actor_name">From {{ notificationPayload(notification.payload).actor_name }}</p>
        <p>{{ notificationPayload(notification.payload).register_id }}</p><p class="excerpt">{{ notificationPayload(notification.payload).excerpt || notificationPayload(notification.payload).reason }}</p>
        <a :href="discussionLink(notification.submission_id)">Open submission discussion</a>
        <button v-if="!notification.read_at" @click="markRead(notification.id)">Mark as read</button>
        <small>Email: {{ notification.email_status }}<span v-if="notification.email_reason"> · {{ notification.email_reason }}</span></small>
      </article></li></ol>
    </fieldset>
    <form @submit.prevent="savePrefs"><fieldset :disabled="busy"><legend>Email notifications</legend><label>Delivery preference <select v-model="level" required><option value="" disabled>Choose a preference</option><option value="all">All activity</option><option value="mentions">Mentions and actions requiring me</option><option value="none">No email</option></select></label><p>These preferences control email. Notifications remain available in your inbox.</p><button>Save email preference</button></fieldset></form>
    <form @submit.prevent="saveHandle"><fieldset :disabled="busy"><legend>Mention handle</legend><p v-if="savedHandle">Your saved handle is @{{ savedHandle }}.</p><label>Handle <input v-model="handle" required minlength="3" maxlength="32" pattern="[a-zA-Z0-9][a-zA-Z0-9._\-]{2,31}" /></label><p>Use 3–32 letters, numbers, dots, underscores, or hyphens. A saved handle can change once per 30 days.</p><button>Save mention handle</button></fieldset></form>
  </div>
</template>
<style scoped>.inbox { max-width: 65rem; margin: 2rem auto; } fieldset { border: 1px solid #9baaba; padding: 1rem; margin: 1rem 0; } label, small { display: block; margin: .5rem 0; } input, select, button { border: 1px solid #708397; padding: .4rem; max-width: 100%; } article { margin-bottom: 1rem; border-bottom: 1px solid #9baaba; padding: .5rem; } .error { color: #a51b27; } .excerpt { white-space: pre-wrap; overflow-wrap: anywhere; }</style>
