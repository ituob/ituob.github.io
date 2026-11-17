# Content parity rendering and projection repairs

The 95% count-aware threshold and existing exclusions are unchanged. All 28
pages failing site commit `1d0f2965` now pass the scoped re-score. Each score is
the minimum across every included reference variant for that page. Reference
HTML hashes were checked against the pinned receipt before caching all 604
reference token tallies. The canonical tokenizer and multiset metric are unchanged.

The 28 affected routes were built in isolation from the exact authored projection
retained by build run 44093145773, with pinned itu-ob-data `90f99728`, the historical
cell repairs below, and the existing register snapshot cache. The isolated layout
contains route content inside `main`, without unrelated site chrome. The final
hosted build regenerates all snapshots and is verified separately at delivery.
No full local site build was run.

| Page | Before | After | Repair |
| --- | ---: | ---: | --- |
| issue/974 | 93.49% | 97.68% | Printed headings/contact labels, amendment source links, amended-position wording and service-restriction page references |
| issue/991 | 94.68% | 99.42% | Numbered technical field descriptions; links and page references |
| issue/1079 | 93.96% | 95.90% | Printed headings/contact labels, amendment source links, amended-position wording and service-restriction page references |
| issue/1087 | 94.12% | 98.53% | Later nested measurement remarks; links, labels and page references |
| issue/1129 | 92.86% | 99.38% | Per-row Tel/Fax/E-mail labels; links and page references |
| issue/1139 | 94.15% | 96.45% | Printed headings/contact labels, amendment source links, amended-position wording and service-restriction page references |
| issue/1167 | 93.68% | 96.04% | Printed headings/contact labels, amendment source links, amended-position wording and service-restriction page references |
| issue/1168 | 93.75% | 96.38% | Station labels; links and page references |
| issue/1175 | 93.66% | 95.96% | Printed headings/contact labels, amendment source links, amended-position wording and service-restriction page references |
| issue/1193 | 94.44% | 96.70% | Printed headings/contact labels, amendment source links, amended-position wording and service-restriction page references |
| issue/1202 | 94.13% | 96.34% | Printed headings/contact labels, amendment source links, amended-position wording and service-restriction page references |
| issue/1204 | 94.06% | 96.19% | Printed headings/contact labels, amendment source links, amended-position wording and service-restriction page references |
| issue/1215 | 94.46% | 96.52% | Printed headings/contact labels, amendment source links, amended-position wording and service-restriction page references |
| issue/1238 | 93.76% | 95.65% | Printed headings/contact labels, amendment source links, amended-position wording and service-restriction page references |
| issue/1264 | 94.90% | 96.91% | Printed headings/contact labels, amendment source links, amended-position wording and service-restriction page references |
| issue/1266 | 91.26% | 95.75% | Empty source-declared MNC amendment heading; links and page references |
| issue/1272 | 94.30% | 98.54% | Printed headings/contact labels, amendment source links, amended-position wording and service-restriction page references |
| issue/1277 | 91.61% | 95.70% | Empty source-declared MNC amendment heading; links and page references |
| issue/1282 | 94.39% | 97.19% | Printed headings/contact labels, amendment source links, amended-position wording and service-restriction page references |
| issue/1310 | 94.49% | 96.02% | Printed headings/contact labels, amendment source links, amended-position wording and service-restriction page references |
| issue/1312 | 94.05% | 95.59% | Printed headings/contact labels, amendment source links, amended-position wording and service-restriction page references |
| issue/1321 | 94.96% | 96.54% | Printed headings/contact labels, amendment source links, amended-position wording and service-restriction page references |
| recommendation/E.212 | 93.79% | 100.00% | Complete operator-brand cells, Country B context, source notes and register-specific annex citations |
| recommendation/F.32 | 88.85% | 100.00% | Full headings, source links and printed QATAR continuation labels |
| recommendation/T.35 | 86.81% | 100.00% | Printed form/action labels, YES/NO values and register-specific annex citations |
| register/e164-acn | 85.81% | 99.59% | Complete Brazil number-pattern cells, printed headings and action captions |
| register/e212-mnc | 93.65% | 100.00% | Full operator headings, French heading, Country B relation and source notes |
| register/f32-tdi | 92.12% | 100.00% | Full destination-indicator/office headings and printed QATAR continuation labels |

No pages in this failure set remain below threshold. No old-site content was
waived as a print error, and no new exclusion was added. E.164 ACN retains a small
navigation-wording difference: a single-year archive does not print “Previous
years”; the missing country/action wording and number patterns are restored.

The repairs preserve source information beyond merely clearing the threshold:

- Brazil's OB 1001 cell contained five number-pattern lines; normalization kept
  only the first. Two OB 1007 operator cells similarly lost their separate
  “trading as LIME” paragraph. `repair-historical-cells.rb` restores complete cells
  from pinned canonical Git blobs only when publication, issue, country, code and
  the existing first line match unambiguously. Both issue files and corresponding
  replay records are repaired before snapshots are generated. Authored patches,
  unrelated fields, ambiguous rows and mismatched identities remain unchanged.
- The E.212 Gabon table's unstyled French heading is preserved. The Swisscom
  extra-territorial row regains its explicit Country B designation, tied to its
  existing operator and MCC/MNC, without duplicating typed ranges or records.
- The [official OB 965 PDF, printed page 21](https://www.itu.int/dms_pub/itu-t/opb/sp/T-SP-OB.965-2010-OAS-PDF-E.pdf#page=21)
  shows three QATAR labels in the destination-indicator table. The populated typed
  record remains singular; the two blank continuation labels are display content.
- Recommendation cards cite each register's own annex. The date in “originally
  published as annex” comes from that issue's publication date; the separate
  “Position on” date is preserved. For T.35 this restores OB 1001 rather than the
  other register's OB 1002; [the official OB 1001 PDF](https://www.itu.int/dms_pub/itu-t/opb/sp/T-SP-OB.1001-2012-OAS-PDF-E.pdf)
  identifies the authority-list annex and its 1 April 2012 position.
- OB 1266 and 1277 declare an empty MNC amendment in the source. Their headers
  survive as explicit placeholders; no dataset rows or nonempty prose are invented.
- OB 1129 already contained the Numbering Plan Office and its fax number. Its
  large deficit came from omitted repeated contact labels. OB 1087 lost remarks
  present only in later nested measurements; OB 991 lost numbered technical field
  descriptions accompanying its typed notes.

Six small Astro/loader fixture tests cover the rendering changes, including
mismatched-row controls, typed-record counts, values, escaping and byte preservation.
Nineteen projection tests cover complete cell repair, immutable source refs,
authored precedence, identity/ambiguity guards, replay interaction and idempotence.
Original behavior fails the corresponding regression assertions. Changed-file
Astro diagnostics, Ruby syntax/focused lint, Python compilation and diff checks pass.

[fixes-scores.json](fixes-scores.json) retains per-variant scores, HTML hashes and
rendering-source hashes. Final hosted HTML scores are reported with the CI run at
delivery; the table above is explicitly scoped rendering evidence.

focused-quality: complete rendering/projection/loader diff and interactions;
fixture data roots and Vite caches were isolated after a CI failure; source-cell
matching and authored byte preservation are covered; no remaining material finding.
