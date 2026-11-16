Part of [#100](https://github.com/ituob/ituob.github.io/issues/100), deferred from
[#111](https://github.com/ituob/ituob.github.io/pull/111) under the PM's printed-OB
condition. Related: [#61](https://github.com/ituob/ituob.github.io/issues/61)
concerns missing front-page annexes rather than this chronology/date policy.

# Align running-annex numbers and position dates with the printed OB

The annex chronology change is not included in #111. The loader remains at the
validated baseline. QA's literal OB 1296 annex-row requirement remains open in
this follow-up; a passing token-coverage percentage does not prove it is fixed.

Two publications have primary printed evidence of multiple annexes:

| Publication | Earlier printed example | Later printed example |
| --- | --- | --- |
| E118_IIN | OB 1161: annex OB 1161, position 1 December 2018 | OB 1283: annex OB 1283, position 31 December 2023 |
| E212_MNC | OB 1161: annex OB 1111, position 1 November 2016 | OB 1283: annex OB 1280, position 15 November 2023 |

Sources: official [OB 1161 English PDF, printed page 3](https://www.itu.int/dms_pub/itu-t/opb/sp/T-SP-OB.1161-2018-OAS-PDF-E.pdf)
and [OB 1283 English PDF, printed page 3](https://www.itu.int/dms_pub/itu-t/opb/sp/T-SP-OB.1283-2024-OAS-PDF-E.pdf).
Corpus events are in `ob-issues/{1161,1162,1280,1283}/annexes.yaml`.

The latest annex numbers agree with these printed examples. The date rule is
not fully confirmed: E.212 stores `position_on: 2023-11-14T23:00:00.000Z`, which
renders `14.XI.2023`, while the printed position is 15 November 2023. E.118
stores `2023-12-31T23:00:00.000Z` and correctly prints 31 December 2023 under UTC;
a blanket CET shift would instead produce 1 January 2024. Missing-date
carry-forward is also unconfirmed: no current annex event omits `position_on`.

[Archived QA reproduction specs](annex-follow-up-regressions.md) retain both
loader and real-Astro-renderer cases, including the original conflicting
pinned-date expectation. They must be reconciled with the printed evidence,
not simply restored as an approved date policy.

Acceptance:
- Confirm latest-annex selection and position dates against the printed OB for
  both publications, including historical issue views.
- Resolve the timestamp/date discrepancy without shifting already-correct dates.
- Define missing-date behavior from a confirmed source or an explicit PM decision.
- Add focused runtime/rendering specs from the confirmed fixtures.
- Deliver this as a separate issue/PR linked to #100 and #111; do not silently
  expand the parity PR's approved scope.

Cortex or a person must post this complete draft: the lane's task-agent guard
blocks issue creation. No issue URL has been invented.
