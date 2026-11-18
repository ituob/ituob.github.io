#!/usr/bin/env bash
# Build the four-template audit site used by the parity measurement
# (docs/content-parity-certification.md, "Original measurement and commands").
# Usage: scripts/parity-audit-build.sh <outDir>   (run from the site root,
# after data/snapshots and OB_DATA_ROOT are in place). Writes a temporary
# srcDir and Astro config outside the tree; commits nothing.
set -euo pipefail
out=$(realpath -m "$1")
root=$(pwd)
tmp=$(mktemp -d)
mkdir -p "$tmp/src/pages/issues/[id]" "$tmp/src/pages/recommendations/[code]" "$tmp/src/pages/registers/[slug]"
for entry in "$root"/src/*; do
  [ "$(basename "$entry")" = pages ] || ln -s "$entry" "$tmp/src/$(basename "$entry")"
done
for page in index.astro 'issues/[id]/index.astro' 'recommendations/[code]/index.astro' 'registers/[slug]/index.astro'; do
  ln -s "$root/src/pages/$page" "$tmp/src/pages/$page"
done
cat > "$root/parity100.config.mjs" <<CFG
import base from "./astro.config.mjs";
export default { ...base, srcDir: "$tmp/src", outDir: "$out" };
CFG
trap 'rm -f "$root/parity100.config.mjs"' EXIT
npm run build -- --config parity100.config.mjs
