// @ts-check
import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import vue from "@astrojs/vue";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import registerSnapshotsIntegration from "./register-snapshots.integration.mjs";

// Data lives in git submodules of this repository.
// data-ob (service-publications-docs) holds the normalized per-issue +
// per-dataset data; data (itu-ob-data) holds the authoritative source
// (used only as a fallback / for cross-referencing).
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { realpathSync } from "node:fs";

const projectRoot = dirname(fileURLToPath(import.meta.url));

const SERVICE_PUBLICATIONS_DOCS = resolve(process.env.OB_DATA_ROOT ?? resolve(projectRoot, "data-ob"));
const OOB_DATA_ROOT = resolve(projectRoot, "data");

// https://astro.build/config
export default defineConfig({
  site: "https://www.ituob.org",
  trailingSlash: "always",
  output: "static",
  integrations: [vue(), mdx(), sitemap(), registerSnapshotsIntegration()],
  vite: {
    plugins: [tailwindcss()],
    // Worktrees may share an installed dependency tree through a symlink.
    server: {
      fs: { allow: [projectRoot, realpathSync(resolve(projectRoot, "node_modules"))] },
      // D1 writes must not reload Astro during sign-in or sign-out.
      watch: { ignored: ["**/.local-dev/**"] },
    },
    define: {
      // Expose data roots to client/server build as import.meta.env vars.
      "import.meta.env.OB_DATA_ROOT": JSON.stringify(SERVICE_PUBLICATIONS_DOCS),
      "import.meta.env.ITU_OB_DATA_ROOT": JSON.stringify(OOB_DATA_ROOT),
    },
    ssr: {
      // YAML is parsed at build time via our own loaders; nothing external.
      noExternal: [],
    },
  },
});
