# Count-aware failures on the saved OB 1343 comparison

The 95% threshold is unchanged. These are failed measurements, not newly approved
exclusions. Scores use each local page's worst included reference variant.
All 604 reference/local HTML hash pairs match the original pinned receipt; 81 saved
rendering source hashes match its build manifest. This isolates the score change
from rendering changes. The saved build predates the latest main integration.

Inspection compared canonical token tallies and the corresponding HTML cells,
labels and prose. A frequency deficit identifies missing text occurrences; it does
not by itself prove missing registry records. The dominant causes below are
observed text differences, not a claim that every residual is harmless.

## Recommendations and registers

| Page | Score | Observed cause and remaining question |
| --- | ---: | --- |
| recommendation/E.212 | 93.71% | 78/1240 occurrences missing. `name` 30→2, `operator` 30→7: reference table labels `Name of Operator/Network` become `networks`. `authoritative` 13→1: repeated resource labels collapse to one. Country-name deficits remain; row equivalence is unproven. |
| recommendation/F.32 | 88.85% | 69/619 missing. Eight repeated reference headers explain `first`, `assigned`, `fourth` 8→0 each, plus `letters` 19→3. New columns use `network code` and `office code` without the printed explanatory wording. Qatar 5→3 remains an occurrence deficit. |
| recommendation/F.400 | 93.85% | 4/65 missing. Printed `AUTO ANSWER` becomes `autoanswer` (two unmatched tokens); `Italy` 3→2 and `TESI` 4→3 remain. New HTML contains the TESI row/contact, but that does not establish row equality. |
| recommendation/T.35 | 87.55% | 34/273 missing. Three reference authority cards repeat `National manufacturers of H-, T- or V-Series compliant equipment?`, assignment-authority, mail and information labels absent from the new rendering; `manufacturers`, `compliant`, `equipment`, `assignment`, `mail`, `information` each lose three occurrences. Norway/China and annex-number deficits remain. |
| register/e164-acn | 85.81% | 81/571 missing. The repeated printed column label `Mobile telephone numbers, first digits after country code` is shortened to `mobile telephone numbers`: `first`, `digits`, `after` each 19→0; `164` 20→2. Number-pattern tokens `7xxx`, `8xxx`, `9xxx`, `9xxxx` are also absent: their semantic equivalence still needs checking. |
| register/e212-mnc | 93.65% | 71/1118 missing. Printed `Name of Operator/Network` columns become `networks`: `name` 37→2 and `operator` 38→9. Spanish column wording and a printed corrigendum (`cancels`, `replaces`, `published`, `page`) also disappear; these residuals require content verification. |
| register/f32-tdi | 92.12% | 48/609 missing. Same F.32 header shortening: `letters` 19→3; `first`, `assigned`, `fourth` 8→0 each; `third` 8→2. Qatar 5→3 remains. |

No threshold reduction, new exclusion, or rendering repair is claimed here.
Restoring literal printed wording or proving an explicitly chosen normalization
would be follow-up work; the current scorer correctly reports these deficits.

## Issue pages

A common observed deficit is repeated `Authoritative resource` TOC labels: Jekyll
places them in `nav.toc > p.authoritative-resource`, while the new rendering has
only one or two occurrences. Another is `amended` from the repeated header
`Position amended originally published as annex to`. These are structural wording
changes but still count under the documented metric. Printed `(page N)` attribution
markers also differ and must not automatically be dismissed as chrome.

The table lists additional observed token deficits (reference→local), including
unresolved content differences. These examples explain the score reduction; they
are not an exhaustive semantic adjudication of every missing occurrence.

| Page | Score | Observed deficit / investigation |
| --- | ---: | --- |
| issue/1079 | 93.81% | TOC resource labels 10→2 each; `code` 24→17. |
| issue/1087 | 94.12% | TOC resource labels 10→2 each; technical terms `vertical` 12→4, `dipoles` 9→3, `polarization` 9→3. |
| issue/1129 | 92.86% | Contact terms `mail` 87→8, `fax` 79→8, `tel` 83→15. Reference HTML contains Bureaufax/contact rows (including Numbering Plan Office / Fax +81 3 5253 5863); new HTML has different contacts. This is a contact/message text mismatch, not merely TOC wording. |
| issue/1139 | 94.19% | `mail` 39→1; `issuer` and `identifier` 17→3 each. Printed email/identifier labels and associated repeated text differ. |
| issue/1161 | 94.30% | `code` 43→32; repeated field text remains unverified. |
| issue/1167 | 93.68% | `mail` 30→10; contact text/labels remain unverified. |
| issue/1168 | 93.75% | `station` 9→0. Reference table rows contain `Station:` labels even though List V/List VIII headings exist in both outputs. |
| issue/1175 | 92.78% | `code` 17→10; `mobile` 24→20. |
| issue/1193 | 94.36% | `tel` 8→4; `fax` 5→1. |
| issue/1202 | 93.86% | `code` 22→16; `mail` 5→2. |
| issue/1204 | 94.06% | `mobile` 25→22. |
| issue/1215 | 94.46% | `code` 15→12; issue token `1125` 2→0. |
| issue/1238 | 93.63% | `code` 30→19; `identification` 17→12. |
| issue/1266 | 91.26% | `mobile` 19→13; `network` 12→9. |
| issue/1272 | 94.30% | `itu` 59→56; `recommendation` 10→8. |
| issue/1277 | 91.61% | `code` 18→11; `mobile` 17→11. |
| issue/1282 | 94.39% | `code` 25→17; `mobile` 22→16. |
| issue/1310 | 94.21% | `code` 46→38; `identification` 18→13. |
| issue/1312 | 93.93% | `code` 43→37; `mobile` 41→37. |
| issue/1321 | 94.96% | `mobile` 35→31; `issuer` 12→8. |
| issue/974 | 93.44% | `information` 14→9; `usage` 6→1. |
| issue/976 | 94.96% | `network` 14→10; `code` 21→17. |
| issue/991 | 94.50% | `information` 30→17; `measurements` 13→2; `accuracy` and `attainable` 9→0 each. Reference amendment includes numbered accuracy/range details, while inspected new text exposes item 12 bandwidth measurements. Technical amendment prose differs; exact source-row reconciliation remains open. |

Repeated field/contact terms may reflect labels, rows or prose. Except for the
HTML examples above, matching each deficit to the corresponding source row remains
unproven. All 23 pages remain below threshold; none is declared harmless or waived.
