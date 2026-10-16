<!--
  CommandPalette — Cmd+K / Ctrl+K navigation overlay (Vue island).

  Surfaces issues, datasets, registers, recommendations for fast nav.
  Pure client-side: builds an index at runtime from a JSON endpoint.
-->
<template>
  <div
    id="cmdk-overlay"
    class="cmdk-overlay no-print"
    :data-open="open ? 'true' : 'false'"
    role="dialog"
    aria-modal="true"
    aria-label="Command palette"
    :hidden="!visible"
    @click="close"
  >
    <div class="cmdk" role="document" @click.stop>
      <input
        type="text"
        id="cmdk-input"
        class="cmdk-input"
        placeholder="Jump to issue, register, dataset, recommendation…"
        autocomplete="off"
        spellcheck="false"
        aria-label="Search"
        :value="query"
        @input="onInput($event)"
        @keydown="onKeydown"
      />
      <div id="cmdk-list" class="cmdk-list" role="listbox" aria-label="Results">
        <template v-if="filtered.length > 0">
          <template v-for="kind in kindsWithItems" :key="kind">
            <div class="cmdk-section-label">{{ kind }}s</div>
            <a
              v-for="it in groups[kind]"
              :key="it.href"
              :href="it.href"
              class="cmdk-item"
              :class="{ 'is-focused': it === filtered[focusedIdx] }"
              @mouseover="focusItem(filtered.indexOf(it))"
            >
              <span class="cmdk-item-title">{{ it.label }}</span>
              <span v-if="it.meta" class="cmdk-item-meta num">{{ it.meta }}</span>
            </a>
          </template>
        </template>
        <div v-else-if="loaded" class="cmdk-section-label">No matches</div>
      </div>
      <div style="display: flex; align-items: center; justify-content: space-between; padding: 0.5rem 0.75rem; border-top: 1px solid var(--border-subtle); font-family: var(--font-sans); font-size: var(--step--3); color: var(--fg-subtle);">
        <span><span class="kbd">↑</span> <span class="kbd">↓</span> navigate · <span class="kbd">↵</span> open · <span class="kbd">esc</span> close</span>
        <span id="cmdk-count">{{ filtered.length }} results</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";

interface CmdkItem {
  kind: string;
  label: string;
  href: string;
  meta?: string;
  boost?: number;
  _score?: number;
}

const KINDS = ["issue", "register", "dataset", "recommendation", "page"];

const open = ref(false);
const visible = ref(false);
const query = ref("");
const focusedIdx = ref(0);
const loaded = ref(false);

let INDEX: CmdkItem[] | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;

const filtered = computed<CmdkItem[]>(() => {
  if (!INDEX) return [];
  const out: CmdkItem[] = [];
  for (const item of INDEX) {
    const s = score(`${item.label} ${item.meta || ""}`, query.value);
    if (s < 0) continue;
    item._score = s + (item.boost || 0);
    out.push(item);
  }
  out.sort((a, b) => (b._score || 0) - (a._score || 0));
  return out.slice(0, 50);
});

const groups = computed<Record<string, CmdkItem[]>>(() => {
  const g: Record<string, CmdkItem[]> = {};
  for (const it of filtered.value) {
    (g[it.kind] ||= []).push(it);
  }
  return g;
});

const kindsWithItems = computed(() => KINDS.filter((k) => groups.value[k]?.length));

function score(hay: string, needle: string): number {
  if (!needle) return 1;
  const h = hay.toLowerCase();
  const n = needle.toLowerCase();
  if (h === n) return 1000;
  if (h.indexOf(n) === 0) return 500;
  const ix = h.indexOf(n);
  if (ix >= 0) return 200 - ix;
  let m = 0;
  let j = 0;
  for (let i = 0; i < n.length; i++) {
    const c = n[i];
    while (j < h.length && h[j] !== c) j++;
    if (j >= h.length) return -1;
    m += 1;
    j++;
  }
  return m * 5;
}

function loadIndex(cb: () => void) {
  if (INDEX) return cb();
  fetch("/cmdk-index.json")
    .then((r) => (r.ok ? r.json() : []))
    .then((data: CmdkItem[]) => {
      INDEX = data;
      loaded.value = true;
      cb();
    })
    .catch(() => {
      loaded.value = true;
      cb();
    });
}

function openPalette() {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
  visible.value = true;
  requestAnimationFrame(() => {
    open.value = true;
    query.value = "";
    focusedIdx.value = 0;
    const input = document.getElementById("cmdk-input") as HTMLInputElement | null;
    if (input) input.focus();
    loadIndex(() => {});
  });
}

function close() {
  open.value = false;
  closeTimer = setTimeout(() => {
    visible.value = false;
  }, 200);
}

function onInput(e: Event) {
  query.value = (e.target as HTMLInputElement).value;
  focusedIdx.value = 0;
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    moveFocus(1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    moveFocus(-1);
  } else if (e.key === "Enter") {
    e.preventDefault();
    const it = filtered.value[focusedIdx.value];
    if (it) window.location.href = it.href;
  } else if (e.key === "Escape") {
    e.preventDefault();
    close();
  }
}

function focusItem(idx: number) {
  if (idx >= 0) focusedIdx.value = idx;
}

function moveFocus(delta: number) {
  if (!filtered.value.length) return;
  focusedIdx.value =
    (focusedIdx.value + delta + filtered.value.length) % filtered.value.length;
}

watch(focusedIdx, () => {
  document
    .querySelector("#cmdk-list .cmdk-item.is-focused")
    ?.scrollIntoView({ block: "nearest" });
});

function onGlobalKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (open.value) close();
    else openPalette();
  } else if (e.key === "Escape" && open.value) {
    close();
  }
}

function onTriggerClick(e: MouseEvent) {
  const el = (e.target as HTMLElement | null)?.closest?.("#cmdk-trigger");
  if (el) openPalette();
}

onMounted(() => {
  document.addEventListener("keydown", onGlobalKeydown);
  document.addEventListener("click", onTriggerClick);
});

onUnmounted(() => {
  document.removeEventListener("keydown", onGlobalKeydown);
  document.removeEventListener("click", onTriggerClick);
  if (closeTimer) clearTimeout(closeTimer);
});
</script>
