<!-- Theme toggle — Vue island owning the header colour-theme button. -->
<template>
  <button
    type="button"
    id="theme-toggle"
    class="icon-btn"
    aria-label="Toggle colour theme"
    title="Toggle theme"
    @click="toggle"
  >
    ◐
  </button>
</template>

<script setup lang="ts">
function toggle() {
  const isDark = document.documentElement.classList.toggle("dark");
  document.documentElement.classList.toggle("light", !isDark);
  try {
    localStorage.setItem("ob-theme", isDark ? "dark" : "light");
  } catch {
    /* storage unavailable */
  }
}
</script>
