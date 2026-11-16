# QA regression: latest annex event on OB 1296

The reproduction uses the pinned `service-publications-docs` corpus (`0651a679`).
Before the fix, `E212_MNC` retained its first annex number, OB 958, while its date
was updated from later events. The separately printed OB 1117 row belongs to
`E212_ICC`, not MNC, and must remain intact.

The change pairs each publication's latest event number and date, as bounded by
the requested issue. It introduces no date conversion or missing-date fallback.

| Case | Expected |
| --- | --- |
| E212_MNC at OB 1296 | OB 1280; `2023-11-14T23:00:00.000Z`; `14.XI.2023` |
| E118_IIN at OB 1296 | OB 1283; `31.XII.2023`; ordered ahead of E212_MNC |
| E212_MNC at OB 1162 and OB 1279 | OB 1162; `15.XII.2018`; no future event |
| Separate E212_ICC row at OB 1296 | OB 1117; `1.II.2017` |

`test/running-annexes.test.mjs` exercises the actual loader and existing date
formatter against that corpus. `test/running-annexes-render.test.mjs` compiles the
actual `RunningAnnexes.astro` component with Astro's compiler options and renders
it with AstroContainer using the real OB 1296 payload. It checks the MNC row by
publication link, independently of the country-code row. This small in-memory
renderer does not replace the required full-site parity build.

The tests were also run against an isolated copy of the original tracked loader:
four chronology assertions failed and the two preservation assertions passed.
With the correction, all six pass. No test was skipped or weakened.

```sh
node --experimental-strip-types --test test/running-annexes.test.mjs test/running-annexes-render.test.mjs
npm run check
```

Full parity evidence must be regenerated from a successful build of the changed
source. The existing reports remain available as a labelled pre-QA baseline;
their source-hash checks correctly detect that they are stale. The full-build
guard is currently below its 12 GB disk minimum. Obsolete outputs created by
this task were removed; unrelated projects were not deleted to bypass the guard.
