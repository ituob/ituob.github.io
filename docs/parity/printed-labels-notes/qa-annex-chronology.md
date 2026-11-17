# QA chronology reproduction: deferred under the PM decision

The pinned-corpus QA request exposed stale running-annex selection. The MNC row
retains its first annex number, OB 958, while its date reflects a later event.
The separate OB 1117 country-code row is a different publication and must not be
mistaken for the MNC row.

An exploratory latest-record patch passed six focused specs. Review then
confirmed that its pinned `14.XI.2023` expectation does not establish agreement
with the printed 15 November date. Under the PM's fallback, that patch and its
active tests have been removed from this PR. The exact reproduction tests are
[preserved with the follow-up](annex-follow-up-regressions.md).

The new evidence regressions fail when the loader differs from the successful
build/audit and when the unconfirmed policy is not explicitly deferred. The
retained loader now matches both unchanged source receipts. All 66 rendering
inputs can therefore be checked against the existing successful fixture build;
no receipt has been edited to manufacture a passing result.

The [follow-up draft](annex-follow-up.md) includes two publications with multiple
printed annexes, the unresolved date and missing-date policy, and acceptance
checks. This PR does not claim the chronology QA item is complete.
