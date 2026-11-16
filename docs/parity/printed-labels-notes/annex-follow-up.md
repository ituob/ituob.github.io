Part of [#100](https://github.com/ituob/ituob.github.io/issues/100), following
[#111](https://github.com/ituob/ituob.github.io/pull/111). Related:
[#61](https://github.com/ituob/ituob.github.io/issues/61) concerns missing
front-page annexes rather than position-date interpretation.

# Reconcile annex position timestamps with the printed dates

QA's OB 1296 reproduction has been fixed in #111: each publication now uses its
latest annex event number and the date stored in that event. The regression
expects E212_MNC at OB 1280, `14.XI.2023`, from the pinned timestamp
`2023-11-14T23:00:00.000Z`. This follow-up no longer defers annex-number selection.
The remaining policy question concerns the `position_on` data and its date interpretation.

The official [OB 1283 English PDF, printed page 3](https://www.itu.int/dms_pub/itu-t/opb/sp/T-SP-OB.1283-2024-OAS-PDF-E.pdf)
lists E.212 at OB 1280 with position 15 November 2023. Its E.118 entry is OB 1283,
position 31 December 2023. However, the E.118 record stores
`2023-12-31T23:00:00.000Z` and already renders 31 December under UTC. A blanket
CET conversion would incorrectly move that record to 1 January 2024.

Acceptance:
- Resolve each timestamp's intended date against primary printed evidence.
- Fix data or narrowly defined date interpretation without shifting correct dates
  in unrelated contexts.
- Define missing-date behavior only with primary evidence or an explicit
  maintainer decision. No carry-forward rule is introduced in #111.
- Add focused data/date regression fixtures for the confirmed policy.

The lane guard requires Cortex or a person to create this follow-up issue. No
issue URL has been invented for this draft.
