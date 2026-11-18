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

After the fix, OB 1263, 1262, 1250, 1200, 1056, 1034 and 969 match production on
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


## Second pass: remaining differences (claude-a/parity-close)

Jekyll source of truth: `_includes/issue/message.html` and
`_plugins/issue_data_reader.rb` at a95ab191 (the pinned reference build).
Regression = the Astro rule differs from Jekyll's and the data would render the
same way under Jekyll. Corpus-driven = production differs only because the
data changed after the 2023 deployment. Existed at base 9d66d728: all of the
regressions below (they come from the original Astro rewrite, 4830a81e).

| Item | Jekyll rule | Astro rule (before) | Verdict | Fix |
| --- | --- | --- | --- | --- |
| Extra Amendments article on OB 974 (ADMD), 980 (Telegram Destination Indicators), 1002 (Country or Geographical Area Codes) | One article per entry of `amendments.messages`. A list annexed in an issue appears under Annexes only. | The issue page also added every register whose `seed_issue` is this issue. | Regression | Seed registers are no longer added to the amendment list. |
| Extra "Bureaufax Table" on OB 1000 | Same: one article per source message. | Same rule; the source has the message. | Corpus-driven. The message was added to `data/issues/1000/amendments.yaml` on 2025-05-19 (data commit e25c4ae, "correct bad encoding of issue 1000"), after the production build. Jekyll would render it too. | none |
| OB 965 title "(MID)" | `site.message_types.mid.title` is "Maritime Identification Digits". | `GENERAL_TYPE_LABELS.mid` had "(MID)". | Regression (OB 980's "(MID)" is a custom message title in the data and stays). | Label corrected in `src/lib/catalogs.ts` (also used by `/types/mid/`). |
| Amendment numbers (OB 1263 78/145/51 vs blank; OB 1100 7/26/32 vs 3/23/31) | `seq_no` counts amendment messages against the target's current annex (see `issue_data_reader.rb`, `load_amendment_message`): the target must name no position or the annexed one, and the issue must not predate it. Otherwise no number. | Counted issues containing the publication since the last annex, ignoring positions. | Regression | `jekyllAmendmentNumber()` (src/lib/loaders.ts) ports the Jekyll rule. A bare-date target position is equal to the annex timestamp one hour later in UTC (OB 1089 vs the 2014-12-31T23:00Z annex), which is what production showed for OB 1100 ISPC. |
| "Amd. 2" label | `Amd. no. N to` with title "Amendment no. N since specified position was published". | `Amd. N to`, title "Amendment". | Regression | Label and title restored. |
| "Other communications" twice on OB 1167, 1168, 1170 | One article per source message; the source holds one asset reference and the same text inlined, and Jekyll rendered both. | `dedupeAssetTwins` dropped the inlined twin. | Regression | The issue page reads `general.textualWithTwins`; `general.textual` stays deduplicated for the other consumers (language page, search, timeline). |

The planned-issues row count on OB 1263 (2 on production, 25 locally) remains
corpus-driven, as above.

## Deliberate differences

* **Titled `custom` messages have a TOC label.** Production emits an empty
  `<a href="#general-3"></a>` for them (Jekyll's TOC looked up
  `message_types.custom.title`, which is empty), so the TOC shows blank
  entries (OB 1263 `general-3` and `general-6`; also OB 1034 and OB 969). We label the link with the message's own title. This is the one
  text difference in the TOC and removes unnamed links.
* **Planned-issues table length is corpus-driven.** Jekyll
  (`_plugins/issue_data_reader.rb#backfill_planned_issue` + `_layouts/issue.html`,
  `limit:25`) lists every issue with a higher id than the current one, ascending,
  capped at 25. We do the same (next 25 ids after this one). Production's corpus
  ends at OB 1264 (`/issues/1265-en/` is a 404), ours runs to 1343, so pages whose
  successors reach past 1264 differ: OB 1263 prod 1 row (1264) vs ours 25; OB 1250
  prod 14 (1251-1264) vs 25; OB 1240 prod 24 vs 25. Where 25 successors exist on
  both sides (OB 1100, 1200) the tables match. No code change.
* **Header strip, title banner and contact-line wrapping** follow the new site
  design (header navigation, Sign in) and are out of scope for parity.

## Not changed

`/issues/<n>/<lang>/` pages (`[lang].astro`) use a separate layout without the
Jekyll TOC and were not in this audit.
