/**
 * Reasons for register changes the replay engine could not apply.
 *
 * The replay ledger is data-ob/docs/normalization/replay-skips.tsv (one row
 * per skip, error text copied verbatim from the snapshot's `errors`), with the
 * meaning of each class defined in docs/normalization/replay-skips.adoc.
 * The register page shows each skipped change with its reason instead of a
 * bare "N replay errors" count.
 */

export interface ReplaySkipRow {
  register: string;
  obIssue: number;
  patch: string;
  error: string;
  cls: string;
  printRef: string;
}

export interface ExplainedSkip {
  /** The replay error text, verbatim. */
  error: string;
  /** Why this change was not applied. */
  reason: string;
  /** Where the printed wording lives, when the ledger records it. */
  printRef: string | null;
  /** Ledger class (S/E/T/D/G), or null for skips outside the ledger. */
  cls: string | null;
}

/** Parse the ledger (tab separated, fields may be double-quoted with "" escapes). */
export function parseReplaySkips(tsv: string): ReplaySkipRow[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < tsv.length; i++) {
    const c = tsv[i]!;
    if (quoted) {
      if (c === '"' && tsv[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === "\t") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  const [, ...body] = rows;
  return body
    .filter((r) => r.length >= 6)
    .map((r) => ({
      register: r[0]!,
      obIssue: Number.parseInt(r[1]!, 10),
      patch: r[2]!,
      error: r[3]!,
      cls: r[4]!,
      printRef: r[5]!,
    }));
}

const CLASS_REASON: Record<string, string> = {
  S: "The register is seeded from an existing dataset; this change targets a row that seed does not carry.",
  E: "Seed-issue suppression: the entry was already absent from the post-amendment annex that seeds this register, so there is nothing left to withdraw.",
  T: "The printed action type differs from the patch; the patch is corrected from print.",
  D: "Mis-filed patch: the printed wording carries a different register's columns, so it cannot match an entry here.",
  G: "Documented source gap: the printed bulletin withdraws an entry that no earlier seed, patch or print in the corpus ever added.",
};

/** Register-specific wording for the documented source gaps (replay-skips.adoc). */
const SOURCE_GAP_REASON: Record<string, string> = {
  E212_MNC:
    "The withdrawal is the only printed mention of this code; the corresponding addition appears in no seed, dataset patch or print in this corpus, so there is no key to withdraw.",
  X121_DNIC:
    "The printed withdrawal names a code absent from the OB 977 seed and from every intervening patch through OB 1080; the printed seed table is unavailable in repository text.",
};

/** Reasons for the two skip kinds that carry no ledger row. */
const LIR_REASON =
  "LIR amendments record a printed-table position rather than an entry key, so the replay cannot match them; the current list is unaffected.";
const DUPLICATE_REASON = "The entry already exists in the register, so adding it again changed nothing.";

/**
 * Explain every replay error of one register. `registerId` is the catalog id
 * (E212_MNC, ...) the ledger is keyed by. An error with no ledger row is still
 * listed, and says so, rather than being dropped from the count.
 */
export function explainSkips(errors: readonly string[], registerId: string, ledger: readonly ReplaySkipRow[]): ExplainedSkip[] {
  return errors.map((error) => {
    const row = ledger.find((r) => r.register === registerId && r.error === error);
    if (row) {
      const reason = row.cls === "G" ? (SOURCE_GAP_REASON[row.register] ?? CLASS_REASON.G!) : (CLASS_REASON[row.cls] ?? "Recorded in the replay ledger.");
      return { error, reason, printRef: row.printRef || null, cls: row.cls };
    }
    if (error.startsWith("skip LIR")) return { error, reason: LIR_REASON, printRef: null, cls: null };
    if (error.includes("already exists")) return { error, reason: DUPLICATE_REASON, printRef: null, cls: null };
    return { error, reason: "Not yet classified in the replay ledger (docs/normalization/replay-skips.tsv).", printRef: null, cls: null };
  });
}
