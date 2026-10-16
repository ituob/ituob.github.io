<!--
  ScrollSpy — headless Vue island for the issue-page section nav.
  Observes the targets of [data-target] links inside [data-scrollspy]
  and highlights the link whose section is in view.
-->
<template>
  <!-- scrollspy island -->
</template>

<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";

const props = withDefaults(defineProps<{ rootSelector?: string }>(), {
  rootSelector: "[data-scrollspy]",
});

let observer: IntersectionObserver | null = null;

onMounted(() => {
  const nav = document.querySelector(props.rootSelector);
  if (!nav) return;
  const links = Array.from(nav.querySelectorAll<HTMLAnchorElement>("[data-target]"));
  const targets = links
    .map((link) => {
      const id = link.getAttribute("data-target");
      const el = id ? document.getElementById(id) : null;
      return el ? { el, link } : null;
    })
    .filter((t): t is { el: HTMLElement; link: HTMLAnchorElement } => t !== null);
  if (targets.length === 0) return;

  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        links.forEach((l) => l.classList.remove("is-active"));
        const match = targets.find((t) => t.el === entry.target);
        if (match) match.link.classList.add("is-active");
      }
    },
    { rootMargin: "-25% 0px -65% 0px", threshold: 0 },
  );
  targets.forEach((t) => observer!.observe(t.el));
});

onUnmounted(() => {
  observer?.disconnect();
  observer = null;
});
</script>
