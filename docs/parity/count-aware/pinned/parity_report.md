# Page-by-page parity validation report

Generated against:
- deployed reference: `reference`
- new site: `build`

Worst-variant rule: a page passes only when EVERY deployed
variant of it passes ≥95%.

## Summary

| verdict | count | percent |
|---------|-------|---------|
| pass (≥95%) | 392 | 92.9% |
| warn (80-95%) | 30 | 7.1% |
| fail (<80%) | 0 | 0.0% |
| missing (no local) | 0 | 0.0% |
| **total** | **422** | |

## index — 1 pages, avg 98.5%, 1/1 pass

_All pages pass ≥95% parity._

## issue — 389 pages, avg 97.3%, 366/389 pass

### Pages below 95% coverage

| page | coverage | variants | missing headings | missing links | missing tables |
|------|----------|----------|------------------|---------------|----------------|
| issue/1266 | 91.3% | 1 | 10 | 10 | 1 |
| issue/1277 | 91.6% | 1 | 12 | 14 | 0 |
| issue/1175 | 92.8% | 1 | 13 | 11 | 0 |
| issue/1129 | 92.9% | 1 | 15 | 11 | 0 |
| issue/974 | 93.4% | 1 | 17 | 7 | 0 |
| issue/1238 | 93.6% | 1 | 13 | 10 | 1 |
| issue/1167 | 93.7% | 1 | 12 | 9 | 0 |
| issue/1168 | 93.8% | 1 | 13 | 11 | 0 |
| issue/1079 | 93.8% | 1 | 14 | 12 | 0 |
| issue/1202 | 93.9% | 1 | 12 | 9 | 0 |

### Specific heading gaps (worst 3 pages)

#### Issue 1266

Coverage: 91.3% — 10 missing headings:

- lists annexed to the itu operational bulletin
- approval of itu-t recommendations
- international identification plan for public networks and subscriptions
- telephone service
- testing laboratories recognized by itu
- service restrictions
- call-back and alternative calling procedures (res. 21 rev. pp-2006)
- list of issuer identifier numbers for the international telecommunication charge card
- mobile network codes (mnc) for the international identification plan for public networks and subscri
- list of itu carrier codes

#### Issue 1277

Coverage: 91.6% — 12 missing headings:

- lists annexed to the itu operational bulletin
- approval of itu-t recommendations
- the international public telecommunication numbering plan
- telephone service
- international identification plan for public networks and subscriptions
- service restrictions
- call-back and alternative calling procedures (res. 21 rev. pp-2006)
- list v - list of ship stations and maritime mobile service identity assignments
- list of recommendation itu-t e.164 assigned country codes
- mobile network codes (mnc) for the international identification plan for public networks and subscri
- list of international signalling point codes (ispc)
- national numbering plan

#### Issue 1175

Coverage: 92.8% — 13 missing headings:

- lists annexed to the itu operational bulletin
- approval of itu-t recommendations
- telephone service
- service restrictions
- call-back and alternative calling procedures (res. 21 rev. pp-2006)
- the international public telecommunication numbering plan
- international identification plan for public networks and subscriptions
- list v - list of ship stations and maritime mobile service identity assignments
- list of issuer identifier numbers for the international telecommunication charge card
- list of recommendation itu-t e.164 assigned country codes
- mobile network codes (mnc) for the international identification plan for public networks and subscri
- list of international signalling point codes (ispc)
- national numbering plan

## recommendation — 12 pages, avg 95.7%, 8/12 pass

### Pages below 95% coverage

| page | coverage | variants | missing headings | missing links | missing tables |
|------|----------|----------|------------------|---------------|----------------|
| recommendation/T.35 | 87.5% | 1 | 0 | 1 | 1 |
| recommendation/F.32 | 88.9% | 1 | 0 | 0 | 0 |
| recommendation/E.212 | 93.7% | 1 | 1 | 1 | 0 |
| recommendation/F.400 | 93.8% | 2 | 0 | 0 | 0 |

### Specific heading gaps (worst 3 pages)

#### Rec E.212 (year subpage)

Coverage: 93.7% — 1 missing headings:

- mcc + mnc*

## register — 20 pages, avg 97.2%, 17/20 pass

### Pages below 95% coverage

| page | coverage | variants | missing headings | missing links | missing tables |
|------|----------|----------|------------------|---------------|----------------|
| register/e164-acn | 85.8% | 3 | 0 | 0 | 0 |
| register/f32-tdi | 92.1% | 1 | 0 | 0 | 0 |
| register/e212-mnc | 93.6% | 2 | 0 | 0 | 0 |

### Specific heading gaps (worst 3 pages)

## Cross-listed deployed pages (documented anomalies)

These deployed pages embed another register's annex content.
The content is rendered on the owning register's page; the
variants below are excluded from verdicts to avoid double-
attributing a register's data to two pages.

| deployed page | coverage if forced | note |
|---------------|--------------------|------|
| messages/amending-sp F32_TDI (2011-04-15)/index.html | 99.7% | embeds the full OB-1000 BUREAUFAX annex (PARTIE II/III/V fax-booth tables); rendered at /registers/bureaufax/ |
| messages/complement-to-itu-t-r F.32/2012/index.html | 99.5% | embeds the full OB-1000 BUREAUFAX annex (PARTIE II/III/V fax-booth tables); rendered at /registers/bureaufax/ |
