# Issue page structure against the Jekyll original (E-1)

Direction E-1 (owner, PR #97): issue pages emit the original Jekyll DOM.
Audited 2026-11-18 on the dev build of `claude-a/parity-close` against the
deployed Jekyll pages at `https://www.ituob.org/issues/<n>-en/`, comparing the
table of contents (`nav.toc`), the `general-information` and `amendments`
articles with their anchors, and the planned-issues table. Template source of
truth: `_layouts/issue.html`, `_includes/issue/toc.html` at commit `4830a81e^`
(the last Jekyll tree in this repository).

## Regressions found and fixed

| Difference on OB 1263 | Cause | Fix |
| --- | --- | --- |
| TOC and body order of general messages (Telephone Service after Call-back locally, after Approval on production) | Jekyll looped `general.messages` in authored order. The Astro port sorted by a fixed type list (`MESSAGE_TYPE_ORDER`) because the normalized `ob-issues/` projection stores one directory per type and loses the authored sequence. | `loadSourceMessageOrder()` (src/lib/loaders.ts) reads the authored order from `data/issues/<n>/general.yaml`; the page renders one article per message in that order. Issues with no source file (OB 1344 and later, authored in the web app) keep the canonical type order. |
| Order of amendment articles (e.g. ISPC before NNP on OB 1263; List V first on OB 1300) | Same: Jekyll looped `amendments.messages`; the port sorted by dataset slug. | Same loader, `amendments.yaml` order. |
| Two or more `custom` / `iptn` messages merged into one article | The port grouped by type. Jekyll emitted one `article.message` and one `general-N` anchor per message. | One article per message (OB 1263 has `general-3` and `general-6`, both `custom`). |
| TOC link text "Amendments" | Production TOC reads "Amendments to&nbsp;service publications" (the section heading itself is "Amendments" on both). | TOC text restored. |
| TOC lacked the "Annexes" entry for issues that have annexes | Jekyll `toc.html` adds it when `num_annexes > 0`. | Added. |

After the fix, OB 1263, 1262, 1250, 1200, 1056, 1034 and 969 match (1167 differs only by the twin below) production on
TOC order, article classes, titles and anchor ids except for the corpus-driven
and deliberate differences below. OB 1264 matches except the planned-issues
table. OB 1300 and 1350 do not exist on production (404), so they were checked
against the template rules and source order only.

## Corpus-driven differences (no site change)

* **Planned-issues table lists 1264 onward, production lists only 1264.**
  Jekyll filled `planned_issues` with every later edition present in its data
  and showed the first 25 (`limit:25`). The production page is a build of the
  2023 corpus, when 1264 was the only later edition. The Astro page applies the
  same rule to the current corpus (1343 editions plus the web-authored ones).
* **"Note from TSB" is on production too.** It is a `custom` message in the
  corpus (`data/issues/1263/general.yaml`, `general-3`). The earlier audit read
  it as a local addition; production emits the same article body and anchor.

## Deliberate differences

* **Titled `custom` messages have a TOC label.** Production emits an empty
  `<a href="#general-3"></a>` for them (Jekyll's TOC looked up
  `message_types.custom.title`, which is empty), so the TOC shows blank
  entries (OB 1263 `general-3` and `general-6`; also OB 1034 and OB 969). We label the link with the message's own title. This is the one
  text difference in the TOC and removes unnamed links.
* **A misc_communications message authored twice is shown once** (OB 1167
  measured: production has two `general-7`-style articles, we have one; the
  loader comment names OB 1167, 1168 and 1170 as the twin cases). The source
  holds an asset reference and the same text inlined; production shows both. The
  deduplication predates this branch (`dedupeAssetTwins`); the later `general-N`
  anchors of those issues are therefore one lower than on production.
* **Header strip, title banner and contact-line wrapping** follow the new site
  design (header navigation, Sign in) and are out of scope for parity.

## Not changed

`/issues/<n>/<lang>/` pages (`[lang].astro`) use a separate layout without the
Jekyll TOC and were not in this audit.
