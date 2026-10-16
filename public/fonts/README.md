# Vendored Fonts

This directory holds self-hosted WOFF2 font files for offline builds.
The site falls back to Google Fonts CDN when these are absent.

## To download

Run `scripts/download-fonts.sh` (creates it if missing) or manually:

```bash
# Fraunces (variable)
curl -L -o "Fraunces[opsz,wght].woff2" \
  "https://fonts.gstatic.com/s/fraunces/v31/6NUh8FyLNQOQZAnv9bYEvDiIdE9Eto92HsX.woff2"

# Source Serif 4 (variable)
curl -L -o "SourceSerif4[opsz,wght].woff2" \
  "https://fonts.gstatic.com/s/sourceserif4/v8/vesj14NnY7FDwzB4Q4XqSYlP5E0.woff2"

# Inter (variable)
curl -L -o "Inter[opsz,wght].woff2" \
  "https://fonts.gstatic.com/s/inter/v18/UcCo3FwrK3iLTcvneQg7Ca725JhhKnNqk4j1ebLhAm8SrXTcQdpB.woff2"

# JetBrains Mono (variable)
curl -L -o "JetBrainsMono[wght].woff2" \
  "https://fonts.gstatic.com/s/jetbrainsmono/v24/tDba2o-flEEny0FZhsfKu5WU4xD-IQ-PuZJJXxfpAO-Lf1OQk6OThxPA.woff2"
```

## @font-face

The @font-face declarations in `src/styles/global.css` automatically
detect whether the local files exist (via CSS `src: local()` fallback
chain) and fall back to Google Fonts CDN otherwise.
