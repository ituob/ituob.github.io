# Content parity certification (partial), 2026-11-17

Part of ituob/ituob.github.io#100. This is a bounded measurement, not a certification
that every printed item survives as a structured patch. The reports and commands
below identify the exact inputs and unresolved work.

## Count-aware correction (PR #133)

The original results below used **unique-token containment**. They remain historical
receipts; they do not certify multiplicity preservation. The evidence wrapper now
computes uncapped **multiset token containment**:

`sum(min(old_count[token], new_count[token])) / sum(old_count.values)`.

Counts use the canonical auditor's tokens from the first `<main>` (fallback
`<body>`): descendant text leaves joined with spaces, excluding script/style,
canonical date normalization, Unicode word scanning, lowercasing, removal of
stop words, tokens shorter than three characters and punctuation-only runs.
An empty reference token multiset scores 1.0. Added occurrences cannot compensate
for another token's missing occurrences. There is no frequency cap. The threshold
stays **95%**, and each page uses its worst included Jekyll variant. Section,
heading, table and link diagnostics retain their canonical definitions and are
not additional pass conditions. The wrapper changes the page score used by both
the canonical walker output and its retained variant evidence; the submodule's
standalone auditor remains unchanged.

The correction reuses the saved OB 1343 reference and 4,107-page Astro audit build.
It does not rebuild either locally. The latest merge of `origin/main` changes
rendering inputs and the `data-ob` pin, so those saved scores describe the recorded
build, **not the newly merged source**. The earlier unchanged-input statement below
applies only through `ae9b589`. A fresh hosted build is required for current output.

OB 1350 reference scores are **not independently verified**: its original Jekyll
fixture is unavailable here. The old 429-page receipt is internally consistent;
it is not a fresh count-aware measurement, nor independent reference validation.
OB 1344–1350 is outside the available pinned reference.

### Saved-build remeasurement

| Metric | Page min / median | Pages ≥95% | Variant min / median | Included variants ≥95% |
| --- | --- | ---: | --- | ---: |
| Old unique-token containment | 95.5696% / 98.9450% | 422/422 | 95.5696% / 99.1620% | 602/602 |
| New multiset containment | 85.8144% / 97.5544% | 392/422 | 85.8144% / 97.7840% | 565/602 |

The generator exited **1**: 30 pages (37 included variants) are below 95%; none
are missing. The same two existing cross-listed variants remain excluded.
All 604 reference/local HTML hash pairs match the old pinned evidence, and all
81 saved rendering source hashes match its build receipt. Full precision scores
and the complete failing-page list are in [comparison.json](parity/count-aware/comparison.json).
The [count-aware report](parity/count-aware/pinned/parity_report.md) retains YAML,
JSON and CSV companions. Its canonical Markdown/YAML calls 80–95% `warn`; those
are **gate failures** at 95%, as the variant JSON and nonzero exit indicate.
See the [per-page investigation](parity/count-aware/failure-analysis.md) for observed
missing labels, repeated prose and unresolved content differences. These failures
remain visible; no threshold reduction or new exclusion was made.

Reproduce against the saved HTML with the corrected wrapper and a source checkout
matching [build_inputs.json](parity/current-main/build_inputs.json):

```sh
PARITY_SOURCE_ROOT="$SAVED_RENDERING_SOURCE" \
DEPLOYED_SITE="$PINNED_REFERENCE" LOCAL_DIST="$SAVED_ASTRO_BUILD" \
OUTPUT_DIR=docs/parity/count-aware/pinned ruby test/generate_parity_evidence.rb
```

`PARITY_SOURCE_ROOT` attributes source hashes to the saved rendering checkout;
it does not rebuild anything. The canonical walker/auditor bytes are identical
at the old and newly merged submodule pins. The count-aware receipt records the
wrapper SHA-256, and the old evidence remains unchanged.

Regression tests: **10/10 pass**, including deletion of all 100 occurrences of
`critical` (old 20/21 = 95.24%, new 20/120 = 16.67%), deletion of 100 while retaining
one, no cross-token compensation, 94% failure / 95% pass / extra-content bounds,
empty-token reference and the five existing controls. The retained-one regression
was observed red with the old scorer. The same suite is now a hosted CI step.


## Original inputs and unique-token measurement

Build basis: site main `0fb48d1`, included by merge. The branch subsequently
integrates main `ae9b589fbc20f879ec30fd4eb1152e3735709688`; all 81 captured source
hashes and both corpus pins are unchanged across that integration. Verify:

```sh
git diff --name-only 0fb48d1 ae9b589 -- src package-lock.json astro.config.mjs register-snapshots.integration.mjs data data-ob
```

This produced no changed paths; the same rendering-input build is retained.
Normalized corpus (`data-ob`): `ff37cb471a8da399bd12d29bc3a334c080c7f7fe` (OB 1350).
Legacy source (`data`): `90f99728acd1e96d025ce0034fe43a38b572aa62` (OB 1343).
Jekyll source: `a95ab19139e0c65271178c44362f60b48f7eed8c`.

Verify the pins and endpoints without dumping corpus files:

```sh
git rev-parse origin/main
git ls-tree HEAD data data-ob
python3 - <<'PYEND'
from pathlib import Path
for root in [Path("data/issues"), Path("data-ob/ob-issues")]:
    ids = sorted(int(p.name) for p in root.iterdir() if p.is_dir() and p.name.isdigit())
    print(root, len(ids), min(ids), max(ids))
PYEND
```

The two corpus pins differ in endpoint. A comparison against the pinned legacy
source cannot certify OB 1344–1350. The earlier OB 1350 fixture instead used
`itu-ob-data e17484be9f11d6a44d2f5c2ffc3d3e0813ffe62f`.

The canonical script is `data-ob/scripts/parity_report.rb` (in the
service-publications-docs submodule); the historical committed report is
`docs/parity/printed-labels-notes/parity_report.md`. Fresh evidence is kept in
`docs/parity/current-main/` so the older fixture receipt is not overwritten.
The reference build uses the recorded [compatibility patch](parity/current-main/reference-build.patch):
ignore metadata-less directories and skip Relaton title network calls. These are
reference build adaptations, not fixes to registry content.
Ruby 3.1.7 builds Jekyll (3.1.6/mise unavailable locally); Ruby 3.4.8 runs the
existing evidence wrapper; Node 22.23.1 builds Astro.

## Original measurement and commands

The original unique-token generator runs exited 0; every included variant reached 95%.

| Reference | Local pages passing | Included variants passing | Excluded variants | Issue pages |
| --- | ---: | ---: | ---: | ---: |
| Fresh rebuilt pinned source, OB 1343 | 422/422 | 602/602 | 2 | 389/389 |
| Existing OB 1350 fixture | 429/429 | 609/609 | 2 | 396/396 |

Both also cover one homepage, 12 recommendation pages and 20 register pages.
The difference of seven local pages is exactly the seven newer issue pages.
Fresh canonical [pinned report](parity/current-main/pinned/parity_report.md) and
[OB 1350 report](parity/current-main/ob1350/parity_report.md) each have companion
YAML, per-variant JSON (with HTML hashes) and CSV. No exclusions were added.

### Page failure cause table

| Failing local page / variant | Cause | Action |
| --- | --- | --- |
| None in either run | 0 below 95%; 0 missing local pages | No site mapping repair justified |

Every failing **print line** remains listed individually in the 433-row TSV;
every **replay event** remains listed individually in the 46-row conflict table.
Those failures are not erased by the passing page score.

Rebuild the reference from Jekyll `a95ab19`, apply
`docs/parity/current-main/reference-build.patch`, and link its `data` directory
to the site's pinned `data` checkout. With Ruby 3.1.7 and the Jekyll bundle:

```sh
bundle exec jekyll build --destination "$PINNED_REFERENCE" > "$REF_LOG" 2>&1
rg -c 'ERROR: L10N|WARNING: Annex|WARNING: No title' "$REF_LOG"
```

For the audit build, create a temporary source directory. Link every non-`pages`
entry of `src/` into it; within `pages/`, link only these unchanged templates:
`index.astro`, `issues/[id]/index.astro`,
`recommendations/[code]/index.astro`, `registers/[slug]/index.astro`.
Link the completed snapshot output to `data/snapshots`. Use a temporary root-level
Astro config importing `./astro.config.mjs` and spreading its configuration with
`srcDir` set to that temporary source directory and `outDir` to `$ASTRO_BUILD`
(both absolute strings). This follows the earlier fixture's four-type audit
build approach; no template or loader is replaced.

```sh
npm run build -- --config parity100.config.mjs
DEPLOYED_SITE="$PINNED_REFERENCE" LOCAL_DIST="$ASTRO_BUILD" \
OUTPUT_DIR=docs/parity/current-main/pinned ruby test/generate_parity_evidence.rb
DEPLOYED_SITE="$OB1350_REFERENCE" LOCAL_DIST="$ASTRO_BUILD" \
OUTPUT_DIR=docs/parity/current-main/ob1350 ruby test/generate_parity_evidence.rb
```

The second reference is the existing OB 1350 Jekyll fixture at source corpus
`e17484be`, not a newly rebuilt fixture. The first is rebuilt for this audit at
the current `data` pin. The generator invokes the canonical walker and stores
all variants plus HTML hashes, using only its two pre-existing cross-listed
exclusions and the 95% worst-variant threshold. A nonzero exit for below-threshold
coverage is an audit finding, not a successful parity gate.

The earlier full-site build was stopped because it lacked snapshots; a subsequent
archive-wide build was stopped while preparing routes. Neither is claimed as a
passing build. The successful 4,107-page audit build covers the four audited
template types only; full archive, translated and point-in-time route generation
is outside that build proof. The [build receipt](parity/current-main/build_inputs.json)
records all 81 source hashes, verified unchanged after exit 0.

The [reference build receipt](parity/current-main/reference_build.json) records
exit 0 plus 16 localization errors, 1,218 missing-annex warnings, 3,457 skipped
title-fetch warnings, one missing frontend polyfill asset and two legacy-docs
destination collisions. Counts are log occurrences, not distinct missing items. These diagnostics are
not replay conflicts and are not silenced or counted as content fixes. No legacy asset completeness is certified.

### Replay: 46 conflict events at the pinned revision

```sh
cd data-ob
SNAPSHOTS_OUT="$SNAPSHOTS" ruby scripts/generate_register_snapshots.rb
```

Run with Ruby 3.4.8. Completed with exit 0: 21 registers, 953 files,
5 skipped, 0 orchestration errors; manifest integrity 0 errors/0 warnings.
That status does **not** mean conflict-free replay: the completed `current.json`
error arrays contain 46 accumulated SUP conflicts: F32_TDI 34, Q708_ISPC 10,
E118_IIN 1, X121_DNIC 1. Historical `at-*.json` snapshots are not summed. These 46 events group into
7 distinct register + SUP identifier + OB diagnostic prefixes; the JSON records
both units. This is still a different revision from the later five-skip ledger.
[Every event and cause](parity/current-main/replay-conflicts.md) and
[machine-readable inventory](parity/current-main/replay-conflicts.json) are committed.
Recount after generation completes:

```sh
python3 - "$SNAPSHOTS" <<'PYCOUNT'
import collections, json, pathlib, sys
files = list(pathlib.Path(sys.argv[1]).glob("*/current.json"))
counts = {p.parent.name: len(json.loads(p.read_text()).get("errors", [])) for p in files}
print(len(files), sum(counts.values()), {k: v for k, v in counts.items() if v})
groups = {(p.parent.name, e.split(": SUP conflict:")[0])
          for p in files for e in json.loads(p.read_text()).get("errors", [])}
print("diagnostic groups", len(groups))
PYCOUNT
```

The issue's “10” and the progress report's later five-skip inventory are not the
measured state of this older pinned replay implementation. In particular, this
pin replays `datasets/*/changes` through `DirectoryChangeSource`, not a fresh
reconstruction of every `ob-issues` action. Updating that pin and regenerating
projections is follow-up work; no source-data repair is claimed here.

### Print-to-patch coverage: 29,523 / 32,982 mapped (89.51%)

```sh
SITE_ROOT="$PWD"
cd data-ob
ITU_OB_DATA_ROOT="$SITE_ROOT/data/issues" \
OB_ISSUES_ROOT="$SITE_ROOT/data-ob/ob-issues" \
DATASETS_ROOT="$SITE_ROOT/data-ob/datasets" \
REGISTERS_CATALOG="$SITE_ROOT/data-ob/catalogs/registers.yaml" \
COVERAGE_OUT_DIR="$SITE_ROOT/docs/parity/current-main/print-coverage" \
ruby scripts/ob_print_to_patch_coverage.rb
```

Ruby 3.4.8, exit 0. The [fresh coverage report](parity/current-main/print-coverage/100-05-print-to-patch-coverage.md)
records 32,982 printed lines: 29,523 mapped, 3,026 excluded, **433 unmapped**.
The [unmapped cause table](parity/current-main/print-coverage/100-05-unmapped-lines.tsv)
contains every failing line with issue, source line, register, diagnostic cause,
missing tokens and printed text; the [exclusion table](parity/current-main/print-coverage/100-05-excluded-lines.tsv)
contains all 3,026 exclusions.

| Observed cause | Lines | Follow-up |
| --- | ---: | --- |
| Token missing from register patches | 275 | Check source text, typed fields and projection for each listed line |
| List VIII numbered item absent | 48 | Trace each numbered item into the List VIII patch model |
| No token in register patches | 36 | Check missing message/row and register attribution |
| Numeric value or number format | 31 | Compare original numeric values before changing normalization |
| Email address absent | 19 | Check contact extraction and typed payload retention |
| Page marker/action absent | 13 | Determine printed control text versus missing action |
| Country long name/ISO absent | 11 | Check country-heading normalization and stored identity |

These are diagnostic classifications, not verified root-cause repairs.
E118 (111 lines) and E212 MNC (102) account for the largest register groups.
The scan covers the pinned source's 389 amendment files through OB 1343. It
records 286 issue numbers within 669–1343 without `amendments.yaml`; this is an
absence of source files, not a proof that those original printed issues had no
amendments. Original PDFs were not inspected. OB 1344–1350 is outside this scan.

The earlier 447-unmapped/89.4% figure and this pin's committed
446-unmapped/89.44% report used other source inputs; neither is the fresh result.
Token containment allows `mapped_split`, `mapped_text`, `mapped_other` and
`mapped_values_only`; it does not prove one valid typed action per printed row.

### Historical report and belief test

```sh
gh pr view 109 --repo ituob/ituob.github.io --json body,headRefOid
node --test test/parity-evidence.test.mjs
git log --oneline -- docs/parity/printed-labels-notes/parity_report.md
git log --oneline -- src/lib/loaders.ts
```

PR #109 is open at `41ef7c660a9e4a00897e249b758a093e96f15592`; its body
reports 408/429 against OB 1350. The all-pass report arrived later in
`d4e3c3fa37ec3aa12922d6e01c83b4e9099f06ce`, with printed-label/note rendering.
Its fixture corpus and source revision differ from #109 and from current main.
At the audited revision, the existing evidence checks fail 3 of 6 tests: loader source hash and full
build-input manifest no longer match current main. Commit `0940806` subsequently
changed the loader to deduplicate asset/inlined twin messages. Thus the old
429/429 receipt cannot certify today's source. This hash failure alone does not
prove a content regression, and no conclusion is drawn from comparing those
non-equivalent historical counts alone.

**Original belief verdict (unique-token metric):** that measurement reported no
below-threshold page regression and reproduced 429/429 for its OB 1350 fixture.
This is not a count-aware result or independent verification of that reference.
Its historical *source receipt* is stale, as the hash checks demonstrate. PR #109's 408/429 is an earlier build claim, not a measurement
of today's output. This audit does not assign the historical 21-page difference
to individual commits: a controlled rebuild of #109 on identical inputs was
NOT RUN. Full row/action equivalence remains unproven despite the token passes.

### Checks

```sh
node --test test/parity-evidence-generator.test.mjs
npm run check
```

Original generator tests: 5/5 pass. Astro check: 0 errors, 0 warnings, one existing script
hint. No application code changed in this audit. A consistency check also
recomputed every canonical worst-variant score and matched both audit manifests
to all captured build inputs; both report sets passed.

The full staged whitespace check flags four verbatim printed TSV rows and blank
unified-diff context lines in the reference patch. They are retained as generated
evidence; authored documentation has no whitespace errors.


## Verify original committed evidence

This verifies the historical receipts against the saved build source checkout
through `ae9b589`, not the newly merged tree or count-aware evidence.

Run from the site root with Node 22 (exit 0 in this audit):

```sh
node --input-type=module <<'JS'
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
const base = 'docs/parity/current-main';
const build = JSON.parse(fs.readFileSync(`${base}/build_inputs.json`));
for (const [path, sha] of Object.entries(build.source_sha256))
  assert.equal(createHash('sha256').update(fs.readFileSync(path)).digest('hex'), sha, path);
for (const [name, pages, variants] of [['pinned', 422, 602], ['ob1350', 429, 609]]) {
  const evidence = JSON.parse(fs.readFileSync(`${base}/${name}/parity_variants.json`));
  const included = evidence.variants.filter(v => !v.exclusion);
  const summary = Object.values(parse(fs.readFileSync(`${base}/${name}/parity_report.yaml`, 'utf8'))).flat();
  assert.equal(included.length, variants);
  assert.equal(summary.length, pages);
  assert.equal(evidence.excluded_variants, 2);
  for (const row of summary) {
    const label = row[':label'] ?? row.label;
    assert.equal(row[':coverage'] ?? row.coverage,
      Math.min(...included.filter(v => v.label === label).map(v => v.coverage)), label);
  }
  assert.ok(included.every(v => v.coverage >= 0.95 && v.verdict === 'pass'));
  for (const [path, sha] of Object.entries(evidence.source_sha256))
    assert.equal(build.source_sha256[path], sha, path);
}
JS
```

## Limits and follow-ups

- Jekyll reference localization diagnostics and missing annex/title warnings limit
  the reference itself; this audit compares generated HTML and does not certify
  those legacy fields rendered correctly.
- A 95% multiset token-containment score is a one-way occurrence-count check, not a proof
  of row equality, action semantics,
  chronology, absence of extra content, heading/table/link completeness, or all routes. The canonical walker ignores
  unclassified routes and excludes its two documented cross-listed variants.
- The five text-by-design datasets are list-v, coast-stations, bureaufax, rr251,
  and e212-icc. Exclusion does not prove each printed line was retained verbatim.
- Full issue #100 acceptance remains open: explain every unmapped printed line,
  derive all registry schemas from LML, validate seed items through LML, and
  verify the full CI gate chain at the intended corpus revision.
- NOT RUN here: a fresh OB 1350 Jekyll rebuild, original-PDF verification,
  a controlled #109 rebuild on identical inputs, parser equivalence, all-corpus LML action validation, LML instance
  round-trip suite, LML seed validation/schema drift, and register state integrity
  against projections. Snapshot generation alone is not that integrity gate.

## CI gate for the 95% threshold (D100-1)

Two workflows; what runs when:

| Workflow | Runs | What it proves | Runtime |
| --- | --- | --- | --- |
| `build-deploy.yml`, step "Replay-skip reasons and committed parity threshold" | every push and pull request | the **committed receipts** are valid (below) | seconds |
| `parity-remeasure.yml` | pull request or push to `main` that changes a hashed template, `data`/`data-ob`, `package-lock.json`, the scorer, the audit-build script or the workflow itself; and `workflow_dispatch` | a **fresh measurement** of this tree against the pinned Jekyll reference; fails below 95% | about 45-60 minutes on `ubuntu-latest` (Jekyll reference about 43 minutes in parallel with the Astro audit build) |

`tests/parity-threshold.test.ts` (every pull request) fails, with a message and
the regeneration command, when:

1. the receipts directory or a receipt is missing (clean failure, not a crash);
2. any included variant is below 95%, is not `pass`, or the included count
   disagrees with the payload (`pinned` and `ob1350`);
3. the `pinned` receipt was not scored with `multiset-token-containment`
   (older receipts used unique-token containment, which overstates parity);
4. any file in the `pinned` receipt's `source_sha256` (the nine rendering
   sources recorded by `test/generate_parity_evidence.rb`) now hashes
   differently or is gone: the message lists the stale files. The `ob1350`
   receipt is a historical fixture whose Jekyll source is unavailable, so it is
   checked for the threshold only and cannot be regenerated by CI.

`parity-remeasure.yml` rebuilds the reference at the `reference_build.json`
revision with `reference-build.patch`, runs `scripts/parity-audit-build.sh`
(the four-template audit build), then `test/generate_parity_evidence.rb`, which
exits nonzero if any included variant is below 95%. It commits and pushes
nothing; on success the `parity-receipts` artifact is committed by a person over
`docs/parity/current-main/pinned/`, after which the checks above pass. Both
workflows only read; neither changes the 95% threshold or adds exclusions.

Status at this branch: the committed `current-main` receipts predate the
count-aware metric and two hashed templates changed since (issue-page ordering,
register-page skip reasons), so checks 3 and 4 fail until a hosted re-measure is
committed. The saved count-aware measurement (`docs/parity/count-aware`) has 37
included variants below 95%, so that re-measure is also expected to fail the
threshold until those pages are fixed.
