<script setup lang="ts">
import "../../styles/admin-forms.css";
import { onMounted, ref } from "vue";
import { api, type Identity } from "./api";

const identity = ref<Identity | null>(null);
async function load() {
  try { identity.value = await api<Identity>("/api/whoami"); }
  catch { identity.value = null; }
}
onMounted(load);
</script>

<template>
  <div class="header-account">
    <details v-if="identity?.authenticated">
      <summary>{{ identity.user?.displayName || identity.user?.email || identity.userId || 'My account' }}</summary>
      <nav class="account-links" aria-label="Account">
        <a href="/me/">My account</a>
        <form class="admin-form" method="post" action="/auth/logout">
          <button class="admin-button" type="submit">Sign out</button>
        </form>
      </nav>
    </details>
    <a v-else class="sign-in" href="/auth/login?return_to=%2Fme%2F">Sign in</a>
  </div>
</template>

<style scoped>
.header-account { position: relative; flex-shrink: 0; margin-left: auto; font-size: .84rem; font-weight: 600; }
.sign-in, summary { display: block; padding: .42rem .65rem; border-radius: 3px; color: #fff; cursor: pointer; }
.sign-in { text-decoration: none; }
summary { max-width: min(16rem, 70vw); overflow-wrap: anywhere; }
summary::after { content: ' ▾'; }
.sign-in:hover, summary:hover, details[open] summary { background: rgba(255, 255, 255, .16); }
.sign-in:focus-visible, summary:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.account-links { position: absolute; right: 0; top: calc(100% + .35rem); min-width: 10rem; padding: .3rem; background: #fff; color: #333; border: 1px solid #ddd; border-radius: 3px; box-shadow: 0 3px 10px #0002; }
.account-links a { display: block; width: 100%; box-sizing: border-box; padding: .6rem .75rem; border: 0; border-radius: 3px; background: transparent; color: inherit; font: inherit; text-align: left; text-decoration: none; cursor: pointer; }
.account-links a:hover { background: #e3f4fb; }
.account-links form { margin: 0; }
.account-links .admin-button { width: 100%; margin: 0; justify-content: flex-start; }
</style>
