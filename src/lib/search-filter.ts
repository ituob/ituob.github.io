/**
 * Basic client-side search over the build-time command-palette index
 * (`/cmdk-index.json`, entries `{ kind, label, href, meta?, boost? }`).
 * Every whitespace-separated term must occur (case-insensitive) in
 * `label` or `meta`; results rank by match position plus `boost`.
 */
export interface SearchEntry {
  kind: string;
  label: string;
  href: string;
  meta?: string;
  boost?: number;
}

export function filterEntries(entries: SearchEntry[], query: string): SearchEntry[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const [firstTerm] = terms;
  if (firstTerm === undefined) return [];
  const scored: { entry: SearchEntry; score: number }[] = [];
  for (const entry of entries) {
    const label = entry.label.toLowerCase();
    const hay = `${label} ${(entry.meta ?? "").toLowerCase()}`;
    if (!terms.every((t) => hay.includes(t))) continue;
    const first = label.indexOf(firstTerm);
    const position = first === 0 ? 500 : first > 0 ? 200 - first : 0;
    scored.push({ entry, score: position + (entry.boost ?? 0) });
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.entry);
}
