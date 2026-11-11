// Append-only, hash-chained audit trail (docs/submission-workflow.adoc "Audit
// trail"). Nothing in worker/ issues UPDATE or DELETE against audit_log,
// review_state or submission_revisions (asserted by a test).

export interface AuditRow {
  at: string;
  actor_id: string | null;
  actor_kind: "user" | "system" | "github";
  action: string;
  subject_type: "submission" | "comment" | "edition" | "user";
  subject_id: string;
  submission_id: string | null;
  detail: Record<string, unknown> | null;
  request_id?: string | null;
}

const GENESIS = "0".repeat(64);

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const sha256 = sha256Hex;

export function canonical(r: AuditRow): string {
  return JSON.stringify([
    r.at, r.actor_id, r.actor_kind, r.action, r.subject_type, r.subject_id,
    r.submission_id, r.detail === null ? null : JSON.stringify(r.detail), r.request_id ?? null,
  ]);
}

/**
 * Statements appending `rows` to the chain. `guard` is a SQL boolean expression
 * (with its own bound params appended to `guardArgs`) so the rows are written
 * only if the paired state update matched. A concurrent appender makes
 * UNIQUE(prev_hash) fail and the whole batch roll back.
 */
export async function auditStatements(
  db: D1Database,
  rows: AuditRow[],
  guard: { sql: string; args: unknown[] } | null = null,
): Promise<D1PreparedStatement[]> {
  const last = await db.prepare(`SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1`).first<{ hash: string }>();
  let prev = last?.hash ?? GENESIS;
  const out: D1PreparedStatement[] = [];
  for (const r of rows) {
    const hash = await sha256Hex(prev + canonical(r));
    const args = [
      r.at, r.actor_id, r.actor_kind, r.action, r.subject_type, r.subject_id, r.submission_id,
      r.detail === null ? null : JSON.stringify(r.detail), r.request_id ?? null, prev, hash,
    ];
    // Guard params are numbered after the 11 row params.
    const sql = guard ? guard.sql.replace(/\?G(\d+)/g, (_, n) => `?${11 + Number(n)}`) : "";
    out.push(
      db
        .prepare(
          `INSERT INTO audit_log (at,actor_id,actor_kind,action,subject_type,subject_id,submission_id,detail,request_id,prev_hash,hash)
           SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11${guard ? ` WHERE ${sql}` : ""}`,
        )
        .bind(...args, ...(guard?.args ?? [])),
    );
    prev = hash;
  }
  return out;
}

/** Recompute the chain. Returns the id of the first broken row or null. */
export async function verifyChain(db: D1Database): Promise<number | null> {
  const rows = (await db.prepare(`SELECT * FROM audit_log ORDER BY id`).all<any>()).results;
  let prev = GENESIS;
  for (const r of rows) {
    const row: AuditRow = {
      at: r.at, actor_id: r.actor_id, actor_kind: r.actor_kind, action: r.action,
      subject_type: r.subject_type, subject_id: r.subject_id, submission_id: r.submission_id,
      detail: r.detail === null ? null : JSON.parse(r.detail), request_id: r.request_id,
    };
    if (r.prev_hash !== prev || r.hash !== (await sha256Hex(prev + canonical(row)))) return r.id;
    prev = r.hash;
  }
  return null;
}
