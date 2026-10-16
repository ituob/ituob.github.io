<!-- Reading progress bar — headless Vue island (renders no content). -->
<template>
  <!-- reading-progress island -->
</template>

<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";

let bar: HTMLElement | null = null;

function update() {
  if (!bar) return;
  const h = document.documentElement.scrollHeight - document.documentElement.clientHeight;
  const p = h > 0 ? window.scrollY / h : 0;
  bar.style.setProperty("--progress", String(p));
}

onMounted(() => {
  bar = document.createElement("div");
  bar.className = "reading-progress no-print";
  document.body.appendChild(bar);
  window.addEventListener("scroll", update, { passive: true });
  window.addEventListener("resize", update);
  update();
});

onUnmounted(() => {
  window.removeEventListener("scroll", update);
  window.removeEventListener("resize", update);
  bar?.remove();
  bar = null;
});
</script>
