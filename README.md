# ITU Operational Bulletin — ituob.org

The ituob.org website, rebuilt on Astro 7, Vite 8, and Tailwind 4, with
Vue 3 islands for interactive chrome (command palette, theme toggle,
reading progress, scrollspy). The
visual language is "2026 professional elegance, liquid text" — an editorial
broadsheet aesthetic that retains ITU's newspaper-bulletin heritage while
modernizing the typography, color, and responsive behavior.

This replaces the legacy Jekyll site (preserved on the
`rt-jekyll-new-pipeline` branch and in git history).

## Quick start

```bash
git submodule update --init --recursive
npm install
npm run dev      # http://localhost:4321/
npm run build    # static site into dist/
npm run preview  # serve dist/ locally
```

Note: `npm run check` currently reports 187 pre-existing Astro/TS
diagnostics (concentrated in `recommendations/[code]` and
`registers/[slug]` page templates) inherited from the v2 build; the
production build is unaffected. Fixing these and re-enabling the check
in CI is tracked follow-up work.

Requires Node 22+. Register snapshots (`data/snapshots/`) are generated,
not committed — see below.

## Data sources

Data lives in git submodules of this repository:

| Submodule | Repo | Used for |
| --------- | ---- | -------- |
| `data-ob/` | ituob/service-publications-docs | `ob-issues/` per-issue metadata, general messages, amendments; `datasets/` metadata, schema, current snapshot; `catalogs/` |
| `data/` | ituob/itu-ob-data | Authoritative source (issues, `recommendations/` titles) |

Register snapshots are generated into `data/snapshots/` (gitignored) by the
replay engine before every build:

```bash
cd data-ob
SNAPSHOTS_OUT=../data/snapshots bundle exec ruby scripts/generate_register_snapshots.rb
```

CI (`.github/workflows/build-deploy.yml`) runs this automatically between
checkout and build.

## Pages built

| Route                                   | Description                                  |
| --------------------------------------- | -------------------------------------------- |
| `/`                                     | Home: latest issue summary, dataset index.   |
| `/issues/`                              | Issue archive grouped by year.               |
| `/issues/{id}/`                         | Full issue (the "newspaper edition" view).   |
| `/issues/{id}/{lang}/`                  | Localized issue (fr/es/ru/zh/ar).            |
| `/datasets/`                            | All datasets (the "Lists annexed").          |
| `/datasets/{slug}/`                     | Dataset snapshot + recent amendments.        |
| `/datasets/{slug}/history/`             | Full chronological change log.               |
| `/datasets/{slug}/issue/{id}/`          | Amendments a specific issue made.            |
| `/registers/{slug}/`, `/registers/{slug}/at/{id}/`, `/registers/{slug}/history/` | Register snapshots via the replay engine. |
| `/types/`                               | All general message types.                   |
| `/types/{type}/`                        | Cross-issue view of one message type.        |
| `/recommendations/`                     | All referenced ITU-T Recommendations.        |
| `/recommendations/{code}/`              | Per-Recommendation approval history.         |
| `/about/`                               | About the Operational Bulletin.              |
| `/404`                                  | Not-found page.                              |

A sitemap is emitted at `/sitemap-index.xml`.

## Architecture

- `src/lib/catalogs.ts` — canonical catalogs (message types, action types,
  publications). Mirrors `ituob/lib/ituob/catalogs/`. Single source of truth
  for slug ↔ publication-id mapping.
- `src/lib/types.ts` — TypeScript interfaces for every YAML shape loaded.
- `src/lib/loaders.ts` — memoized, null-tolerant loaders. YAML parse errors
  are logged to stderr but never abort the build.
- `src/lib/fs.ts` — filesystem primitives + YAML parser wrapper.
- `register-snapshots.integration.mjs` — build-time integration that
  enumerates `data/snapshots/*/manifest.json` to generate the register
  static paths.
- `src/components/ProseMirror.astro` — recursive ProseMirror renderer.
- `src/components/*Amendment.astro` — per-publication-class renderers.
- `src/components/vue/*.vue` — Vue 3 islands: CommandPalette (Cmd+K),
  ThemeToggle, ReadingProgress, ScrollSpy. Head markup stays static;
  only interactive behaviour is hydrated.
- `src/layouts/Base.astro` — masthead chrome, light/dark mode, print CSS.
- `src/styles/global.css` — Tailwind 4 theme tokens, fluid type scale,
  component utilities, print styles.

## Design system

### Typography

| Role        | Family            | Notes                                  |
| ----------- | ----------------- | -------------------------------------- |
| Display     | Fraunces          | High-contrast variable serif.          |
| Body serif  | Source Serif 4    | Reading measure, ~68ch.                |
| Sans        | Inter             | Nav, metadata, chips. Never body.      |
| Mono        | JetBrains Mono    | Codes (SANC, ISPC, carrier codes).     |

Fluid type scale via `clamp()` (see `--step--1` through `--step-6` in
`global.css`). Body line-height is 1.62.

### Color

- **Anchor**: deep cobalt `#0a2a5e` (ITU heritage blue, refined).
- **Paper**: warm neutrals `#fbf9f4` / `#f7f4ee`.
- **Ink**: `#1a1d2e` light, `#e9e7e0` dark.
- **Accent**: gilt `#b8893a` (used sparingly for masthead rules).

Light + dark via `prefers-color-scheme`, with a manual toggle stored in
`localStorage` under `ob-theme`.

### Accessibility

- Semantic HTML5 throughout (`<article>`, `<section>`, `<nav>`, headings
  in order).
- Skip-to-content link.
- ARIA labels on icon-only controls.
- Focus-visible outlines.
- Color contrast meets WCAG AA in both themes.

### Print

`@media print` produces a clean printable issue: black-on-white, no nav
chrome, page-break rules to keep tables and headings together.

## Known data-quality workarounds

These are issues in the source data, not in the site. The site degrades
gracefully:

- One Arabic locale string in `datasets/1114-E.164D/data.yaml` has an
  unterminated single-quote — the YAML parser logs the error and the dataset
  renders with that entry omitted.
- Issue 999's `annexes.yaml` contains a `null` value — treated as an empty
  annex entry.
- Some amendment files use non-standard action codes (e.g. `001-DJI.yaml`
  uses `DJI` instead of `ADD`). The action regex accepts any uppercase code;
  the chip styling falls back to the literal code.

## Not yet implemented

- Full-text search across issues (would need a client-side index like
  Pagefind; not in scope for this initial build).
- Per-message-type-renderer specializations (e.g. SANC as a dedicated
  country/code table component). Currently SANC and similar textual types
  render via the generic ProseMirror renderer, which faithfully reproduces
  their source content. A dedicated SANC renderer is a follow-up.
- The `recommended` flag on author contacts is loaded but not yet visually
  distinguished.
- Planned-issues schedule data (the `data/planned-issues.yaml` from the
  legacy site) is not yet surfaced.

## Deployment

CI builds and deploys the static site in `dist/` to GitHub Pages:
`staging` branch → staging-www.ituob.org, `main` → www.ituob.org. Pull
requests against `main` additionally run the per-issue audit and
cross-reference validation from `data-ob/`.

Known constraint to watch: `dist/registers/` currently dominates the build
size (~620 MB of ~830 MB total). If the site approaches the GitHub Pages
1 GB limit, register history pages will need to stop inlining full
snapshot payloads.
