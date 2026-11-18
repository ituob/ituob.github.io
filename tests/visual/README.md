# Visual regression checks

Run `DEV_LOCAL_PORT_OFFSET=4000 npm run test:visual` to start an isolated local
HTTPS server, or add `PW_REUSE_SERVER=1` to use one you already started at that
offset. Tests cover Chromium at 1440×900 and 390×900, including all mock personas.
The issue and register examples are pinned to `/issues/1264/` and
`/registers/e212-icc/` so new editions do not silently change the reference pages.

Each page checks its heading, main landmark, representative content or form,
and signed-in/out header state before comparing a full-page screenshot. The
comparison permits 100 changed pixels with a per-pixel threshold of 0.2; it does
not dilute failures with a whole-image percentage on long pages. Contrast remains
an acknowledged design issue logged to `test-results/axe-contrast.jsonl`.

The committed `visual.pw.ts-snapshots/*-chromium-darwin.png` baselines were captured
on macOS with the Chromium revision installed by the locked Playwright version.
Use the same platform/browser for comparisons. Other platforms need their own
reviewed baselines because font rendering differs. To regenerate intentionally,
run the command above with `-- --update-snapshots`, inspect the images, and commit
the PNGs along with the change.

To verify the hidden-content guard, temporarily append
`body > main { opacity: 0; }` to `src/styles/global.css` and run
`DEV_LOCAL_PORT_OFFSET=4000 PW_REUSE_SERVER=1 npm run test:visual -- --grep home`
without updating snapshots. Both widths must fail screenshot comparison. Restore
the stylesheet and rerun the suite before committing.
