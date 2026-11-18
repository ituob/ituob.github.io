/**
 * Amendment number as the Jekyll site computed it (`seq_no`, a95ab191
 * `_plugins/issue_data_reader.rb`): issues are walked oldest first; for each
 * `amendment` message of an issue (before that issue's own annexes are
 * applied) the target's current annex gets a counter, incremented only when
 * the target names no position or the same position as the annex, and the
 * issue is not older than the annex position. Messages that fail either test
 * carry no number, and the label then reads "Amd. to ...". Positions are
 * compared by kind and value, like Ruby (`Date != Time`, unparseable strings
 * never equal); ISO dates only are comparable for ordering.
 */
export type Position = { kind: "date" | "time" | "str"; value: string } | null;

export const jekyllPosition = (v: unknown): Position => {
  if (v === null || v === undefined || v === "") return null;
  const s = v instanceof Date ? v.toISOString() : String(v);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(s)) return { kind: "time", value: s };
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { kind: "date", value: s };
  return { kind: "str", value: s };
};

// A bare date names the same position as a local-midnight timestamp one day
// earlier in UTC (OB 1089 `2015-01-01` vs annex `2014-12-31T23:00:00Z`), which
// the deployed site counted (OB 1100 ISPC shows no. 31 on production). Only a
// timestamp at exactly 23:00:00Z qualifies; a UTC-midnight one (OB 1167
// M1400_ICC `2014-09-15T00:00:00.000Z` vs `2014-09-15`) stays unequal, as in
// Ruby, and production shows no number there.
const localDay = (t: string) =>
  /T23:00:00(\.0+)?Z$/.test(t) ? new Date(Date.parse(t) + 3600_000).toISOString().slice(0, 10) : null;

export const samePosition = (a: Position, b: Position) => {
  if (!a || !b || a.kind === "str" || b.kind === "str") return false;
  if (a.kind === b.kind) return a.value === b.value;
  const [d, t] = a.kind === "date" ? [a, b] : [b, a];
  return d.value === localDay(t.value);
};

export interface SeqIssue {
  id: number;
  publicationDate?: unknown;
  messages: { type?: string; publication?: string; positionOn?: unknown }[];
  annexes: Record<string, { position_on?: unknown } | null>;
}

export function computeJekyllSeqNos(
  issues: SeqIssue[],
  slugOf: (publicationId: string) => string | undefined,
): Map<number, Map<string, number>> {
  const out = new Map<number, Map<string, number>>();
  const annexes = new Map<string, { position: Position; count: number }>();
  for (const issue of issues) {
    const issueDay = jekyllPosition(issue.publicationDate)?.value.slice(0, 10) ?? "";
    const seqs = new Map<string, number>();
    for (const m of issue.messages) {
      if (m.type !== "amendment" || !m.publication) continue;
      const slug = slugOf(m.publication);
      const annex = annexes.get(m.publication);
      const target = jekyllPosition(m.positionOn);
      if (!slug || !annex?.position || annex.position.kind === "str") continue;
      if (target && !samePosition(target, annex.position)) continue;
      if (issueDay && issueDay >= annex.position.value.slice(0, 10)) {
        annex.count += 1;
        if (!seqs.has(slug)) seqs.set(slug, annex.count);
      }
    }
    for (const [pubId, data] of Object.entries(issue.annexes)) {
      annexes.set(pubId, { position: jekyllPosition(data?.position_on), count: 0 });
    }
    out.set(issue.id, seqs);
  }
  return out;
}
