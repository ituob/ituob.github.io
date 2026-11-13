# Printed labels and notes: validation inputs

This validates the changes for [ituob/ituob.github.io#100](https://github.com/ituob/ituob.github.io/issues/100) on main (`ac522eb`) plus this patch.
The generated `parity_report.md` and `parity_report.yaml` use the canonical
`data-ob/scripts/parity_report.rb` and its worst-variant rule, including its two
existing documented cross-listed exceptions.

## Corpus

The lane's pinned submodules end at OB 1343. Its unchanged full build succeeded
(9,149 pages), but comparing that older corpus with the OB 1350 reference gives
407/429 passes, including seven absent issues. That is a different input from
the card's OB 1350 audit; it is not a before/after measure of this patch.

The OB 1350 rescore uses the existing, read-only audit fixtures:

- Normalized data: `/Users/umerhassan/ituob/wt/parity-1111/service-publications-docs`, commit `ff37cb47`.
- Source data: `/Users/umerhassan/ituob/wt/parity-1111/jekyll-src/data`, commit `e17484b`.
- Jekyll reference: `/Users/umerhassan/ituob/wt/parity-1111/jekyll-site`, from the reference checkout at `a95ab19`.
- Register snapshots: generated from the lane's pinned `data-ob` (`0651a679`) with `scripts/generate_register_snapshots.rb`.

A temporary Astro configuration imported this lane's configuration and overrode
`import.meta.env.OB_DATA_ROOT` and `import.meta.env.ITU_OB_DATA_ROOT` with the two
fixture data roots. Its temporary source directory linked this lane's existing
homepage, issue, register, and recommendation templates. All routes for those
four audited page types were built (4,103 pages); no source code from another
branch was imported. The output is `/tmp/ituob-card-120-08-audit/dist`.

The submodule pointers are unchanged. The fixture rescore must not be read as a
claim that this card updates the pinned production corpus to OB 1350.

## Checks

Using Node 22.23.1:

```sh
node --experimental-strip-types --test test/printed-context.test.mjs
SITE_DIST=/tmp/ituob-card-120-08-audit/dist node --test test/printed-context-render.test.mjs
npm run check
```

Both focused test files pass (10 tests). The five rendering regressions all fail
on the unchanged main build and pass on the updated fixture build. Tests also
preserve the typed E.212 entry exactly once, exclude ordinary source table rows,
and check both historical and latest annex publication numbers/dates.
`npm run check` reports 0 errors and 0 warnings (one existing layout hint).
The required Ruby `check.rb` helper exits successfully and reports no applicable
Ruby spec changes.

To regenerate the reports from an OB 1350 build:

```sh
DEPLOYED_SITE=/Users/umerhassan/ituob/wt/parity-1111/jekyll-site \
LOCAL_DIST=/tmp/ituob-card-120-08-audit/dist \
OUTPUT_DIR=docs/parity/printed-labels-notes \
ruby -rset data-ob/scripts/parity_report.rb
```

The audit's libxml2 XPath text sorting is slow on large register pages. This
session used a process-local equivalent descendant-text traversal for
`node_text` and `spaced_text`; no auditor file, threshold, token rule, or variant
selection was edited. Both methods returned identical text on 1,232 content
roots/headings/links across six fixtures, including real pages of all four types
and a script/style/nested-markup fixture. The command above uses the original
implementation and can take longer.

focused-quality: complete rendering patch, source-context extraction, and annex chronology; none.

## Lane PR description

Overlaps #110 in `src/lib/loaders.ts`, `src/pages/issues/[id]/index.astro`, and
`src/pages/registers/[slug]/index.astro`; whichever lands second resolves the conflict.

Link [ituob/ituob.github.io#100](https://github.com/ituob/ituob.github.io/issues/100).
