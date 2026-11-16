Part of [#100](https://github.com/ituob/ituob.github.io/issues/100). Split from [#111](https://github.com/ituob/ituob.github.io/pull/111) after the maintainer required printed-OB validation of the chronology and date behavior. Related: [#61](https://github.com/ituob/ituob.github.io/issues/61), which concerns missing front-page annexes rather than annex chronology.

The chronology change and its two tests were reverted in commit `71083bf9696f1c11f280fcc87585b0ce6463bde2`; `src/lib/loaders.ts` is unchanged from the PR base.

The current `computeRunningAnnexes` retains the first annex OB number while updating its date from later events. The printed list uses the latest annex number:

- Official OB 1283, printed page 3 / PDF page 3, lists E.118 at OB 1283, position 31 December 2023, and E.212 at OB 1280, position 15 November 2023: https://www.itu.int/dms_pub/itu-t/opb/sp/T-SP-OB.1283-2024-OAS-PDF-E.pdf
- Earlier official OB 1161, printed page 3 / PDF page 3, lists E.118 at OB 1161, position 1 December 2018, and E.212 at OB 1111, position 1 November 2016: https://www.itu.int/dms_pub/itu-t/opb/sp/T-SP-OB.1161-2018-OAS-PDF-E.pdf
- Corpus events are in `ob-issues/{1161,1162,1280,1283}/annexes.yaml`.

The proposed change in #111 also carried an earlier `position_on` forward if a later annex omitted its date. No current corpus event omits that date, so that policy could not be checked against a printed OB. It has been removed with the chronology change, per the maintainer's instruction.

There is also an existing date-display discrepancy: the E.212 event stores `2023-11-14T23:00:00.000Z`, `formatObDate` renders 14.XI.2023 using UTC, but the printed list says 15 November 2023. A blanket CET conversion is not supported: E.118 at OB 1283 stores `2023-12-31T23:00:00.000Z` but prints 31 December 2023, so shifting all timestamps to CET would incorrectly show 1 January 2024.

Acceptance:
- Use the latest annex OB number for each publication, with evidence from at least two publications with multiple annexes.
- Resolve date-only versus timestamp interpretation against the printed position dates, without changing other date contexts accidentally.
- Define missing-date behavior only from a confirmed source or an explicit maintainer decision; add a corresponding fixture if applicable.
- Cover historical and current lists with focused specs and preview checks.
