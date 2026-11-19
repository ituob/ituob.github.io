# Page-by-page parity validation report

Generated against:
- deployed reference: `reference`
- new site: `build`

Worst-variant rule: a page passes only when EVERY deployed
variant of it passes ≥95%.

## Summary

| verdict | count | percent |
|---------|-------|---------|
| pass (≥95%) | 429 | 100.0% |
| warn (80-95%) | 0 | 0.0% |
| fail (<80%) | 0 | 0.0% |
| missing (no local) | 0 | 0.0% |
| **total** | **429** | |

## index — 1 pages, avg 98.5%, 1/1 pass

_All pages pass ≥95% parity._

## issue — 396 pages, avg 98.7%, 396/396 pass

_All pages pass ≥95% parity._

## recommendation — 12 pages, avg 99.0%, 12/12 pass

_All pages pass ≥95% parity._

## register — 20 pages, avg 98.8%, 20/20 pass

_All pages pass ≥95% parity._

## Cross-listed deployed pages (documented anomalies)

These deployed pages embed another register's annex content.
The content is rendered on the owning register's page; the
variants below are excluded from verdicts to avoid double-
attributing a register's data to two pages.

| deployed page | coverage if forced | note |
|---------------|--------------------|------|
| messages/amending-sp F32_TDI (2011-04-15)/index.html | 100.0% | embeds the full OB-1000 BUREAUFAX annex (PARTIE II/III/V fax-booth tables); rendered at /registers/bureaufax/ |
| messages/complement-to-itu-t-r F.32/2012/index.html | 100.0% | embeds the full OB-1000 BUREAUFAX annex (PARTIE II/III/V fax-booth tables); rendered at /registers/bureaufax/ |
