# Content parity rendering repairs

The 95% count-aware threshold and existing exclusions are unchanged. All 28
pages failing the site commit `1d0f2965` measurement now pass the scoped re-score.
Scores below are the minimum across every included reference variant for a page.
The original reference HTML hashes were checked against the pinned parity receipt.

The affected routes were built in isolation from the exact authored projection
retained by build run 44093145773, with pinned itu-ob-data `90f99728` and the
existing register snapshot cache. The isolated layout contains the route content
inside `main`, without the unrelated site chrome. This is scoped rendering evidence;
the final hosted build and its artifact are verified separately at delivery.
No full local site build was run.

| Page | Before | After | Repair |
| --- | ---: | ---: | --- |
| issue/974 | 93.49% | 97.68% | Printed headings/contact labels, amendment source links, amended-position wording and service-restriction page references |
| issue/991 | 94.68% | 99.36% | Numbered technical field descriptions; links and page references |
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
| issue/1272 | 94.30% | 95.90% | Printed headings/contact labels, amendment source links, amended-position wording and service-restriction page references |
| issue/1277 | 91.61% | 95.70% | Empty source-declared MNC amendment heading; links and page references |
| issue/1282 | 94.39% | 95.57% | Printed headings/contact labels, amendment source links, amended-position wording and service-restriction page references |
| issue/1310 | 94.49% | 96.02% | Printed headings/contact labels, amendment source links, amended-position wording and service-restriction page references |
| issue/1312 | 94.05% | 95.59% | Printed headings/contact labels, amendment source links, amended-position wording and service-restriction page references |
| issue/1321 | 94.96% | 96.54% | Printed headings/contact labels, amendment source links, amended-position wording and service-restriction page references |
| recommendation/E.212 | 93.79% | 99.68% | Full operator headings, per-amendment resource links and source notes |
| recommendation/F.32 | 88.85% | 99.68% | Full destination-indicator and office-code headings; resource links |
| recommendation/T.35 | 86.81% | 98.17% | Authority form headings, contact/information labels and resource links |
| register/e164-acn | 85.81% | 98.95% | Full E.164/mobile-number column headings; number-pattern values preserved |
| register/e212-mnc | 93.65% | 99.90% | Name of Operator/Network headings and source corrigendum context |
| register/f32-tdi | 92.12% | 100.00% | Full destination-indicator and office-code headings |

No pages are left below threshold in this original failure set. No old-site
content was waived as a print error, and no new exclusion was added.

The two empty MNC declarations are present in the pinned source
`issues/1266/amendments.yaml` and `issues/1277/amendments.yaml`: their contents
objects and both dataset-change arrays are empty. Preserve their publication
headers as explicit placeholders; do not invent rows or substitute source prose
for typed records. Nonempty source messages and existing projected content remain
untouched by this recovery.

Issue 1129 already contained the Numbering Plan Office and its fax number. Its
large deficit came from omitted repeated contact labels, rather than missing those
contacts. Issue 1087 lost remarks found only in later nested measurement objects;
issue 991 lost the numbered field descriptions accompanying its typed notes.

Verification uses small Astro fixture builds in `parity-render.node-test.mjs`,
`amendment-render.node-test.mjs`, `register-parity-render.node-test.mjs` and
`empty-amendments.node-test.mjs`. Original renderers fail the corresponding
regression assertions. Preservation assertions cover contact/measurement values,
number patterns, existing projections, escaping and register status counts.

Machine-readable per-variant scores and HTML hashes are in
[fixes-scores.json](fixes-scores.json). Scoring reuses
`ParityEvidence::Comparisons` and the canonical content-parity tokenizer; no
metric or token-normalization change is part of these repairs.

focused-quality: complete rendering/loader diff and interactions; the empty
amendment test was isolated from real submodule data before delivery; no remaining
material finding.
