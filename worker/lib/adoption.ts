// ITU adoption of generated PDFs (ituob.github.io#106): candidate -> itu-adopted.
// The adoption is pinned to the exact sha256 and is audited; WHO may adopt is
// configuration (ADOPTION_APPROVERS), owned by the site owner.
import { auditStatements } from "./audit.ts";
import { ConflictError, InvalidError, NotFoundError } from "./membership.ts";
import type { Env, Role, Session } from "./types.ts";
import { Forbidden } from "./authz.ts";

/** Default approvers: ITU staff. The owner overrides this with ADOPTION_APPROVERS. */
export const DEFAULT_APPROVERS = "role:itu-editor,role:itu-admin";

export interface Approvers {
  roles: Set<string>;
  emails: Set<string>;
}

const ROLES = new Set<string>(["itu-admin", "itu-editor", "member-submitter"]);

/**
 * Parse `role:<role>` and `email:<address>` tokens, comma separated. Unset or
 * blank means the default. A set value with any malformed token fails closed
 * (nobody may adopt) instead of silently widening or defaulting.
 */
export function parseApprovers(raw: string | undefined): Approvers {
  const text = raw === undefined || raw.trim() === "" ? DEFAULT_APPROVERS : raw;
  const out: Approvers = { roles: new Set(), emails: new Set() };
  for (const token of text.split(",").map((t) => t.trim())) {
    const m = /^(role|email):(.+)$/.exec(token);
    const value = m?.[2]?.trim().toLowerCase();
    if (!m || !value || (m[1] === "role" && !ROLES.has(value)) || (m[1] === "email" && !/^[^@\s]+@[^@\s]+$/.test(value))) {
      return { roles: new Set(), emails: new Set() };
    }
    (m[1] === "role" ? out.roles : out.emails).add(value);
  }
  return out;
}

export function mayAdopt(approvers: Approvers, session: Session, email: string): boolean {
  return session.roles.some((r: Role) => approvers.roles.has(r)) || approvers.emails.has(email.toLowerCase());
}

export interface AdoptionInput {
  standard: string;
  edition_year: number;
  language: string;
  sha256: string;
}

export function parseInput(b: Record<string, unknown>): AdoptionInput {
  const { standard, edition_year, language, sha256 } = b;
  if (typeof standard !== "string" || !/^[A-Za-z0-9.\-_ ]{1,40}$/.test(standard)) throw new InvalidError("standard required");
  if (typeof edition_year !== "number" || !Number.isInteger(edition_year) || edition_year < 1900 || edition_year > 2200) throw new InvalidError("edition_year required");
  if (typeof language !== "string" || !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(language)) throw new InvalidError("language required");
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) throw new InvalidError("sha256 must be 64 lowercase hex characters");
  return { standard, edition_year, language, sha256 };
}

const subjectId = (i: AdoptionInput) => `${i.standard}/${i.edition_year}/${i.language}`;
const now = () => new Date().toISOString();

export async function adopt(env: Env, session: Session, email: string, i: AdoptionInput): Promise<{ id: number }> {
  if (!mayAdopt(parseApprovers(env.ADOPTION_APPROVERS), session, email)) throw new Forbidden();
  const db = env.DB;
  const live = await db
    .prepare(`SELECT id FROM publication_adoptions WHERE standard=?1 AND edition_year=?2 AND language=?3 AND sha256=?4 AND revoked_at IS NULL`)
    .bind(i.standard, i.edition_year, i.language, i.sha256)
    .first();
  if (live) throw new ConflictError("this exact file is already adopted");
  const at = now();
  const audit = await auditStatements(
    db,
    [{ at, actor_id: session.userId, actor_kind: "user", action: "publication.adopted", subject_type: "publication", subject_id: subjectId(i), submission_id: null, detail: { ...i, by: session.userId, email } }],
    { sql: `EXISTS (SELECT 1 FROM publication_adoptions WHERE standard=?G1 AND edition_year=?G2 AND language=?G3 AND sha256=?G4 AND adopted_at=?G5 AND revoked_at IS NULL)`, args: [i.standard, i.edition_year, i.language, i.sha256, at] },
  );
  try {
    const res = await db.batch([
      db.prepare(`INSERT INTO publication_adoptions (standard,edition_year,language,sha256,adopted_by,adopted_at) VALUES (?1,?2,?3,?4,?5,?6)`)
        .bind(i.standard, i.edition_year, i.language, i.sha256, session.userId, at),
      ...audit,
    ]);
    return { id: Number(res[0]!.meta.last_row_id) };
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) throw new ConflictError("this exact file is already adopted");
    throw e;
  }
}

export async function revoke(env: Env, session: Session, email: string, i: AdoptionInput): Promise<void> {
  if (!mayAdopt(parseApprovers(env.ADOPTION_APPROVERS), session, email)) throw new Forbidden();
  const db = env.DB;
  const at = now();
  const audit = await auditStatements(
    db,
    [{ at, actor_id: session.userId, actor_kind: "user", action: "publication.adoption_revoked", subject_type: "publication", subject_id: subjectId(i), submission_id: null, detail: { ...i, by: session.userId, email } }],
    { sql: `EXISTS (SELECT 1 FROM publication_adoptions WHERE standard=?G1 AND edition_year=?G2 AND language=?G3 AND sha256=?G4 AND revoked_at=?G5 AND revoked_by=?G6)`, args: [i.standard, i.edition_year, i.language, i.sha256, at, session.userId] },
  );
  const res = await db.batch([
    db.prepare(`UPDATE publication_adoptions SET revoked_by=?1, revoked_at=?2 WHERE standard=?3 AND edition_year=?4 AND language=?5 AND sha256=?6 AND revoked_at IS NULL`)
      .bind(session.userId, at, i.standard, i.edition_year, i.language, i.sha256),
    ...audit,
  ]);
  if (res[0]!.meta.changes === 0) throw new NotFoundError("no live adoption for this exact file");
}

/** Public read: the live adoption records the downloads page matches against. */
export async function liveAdoptions(db: D1Database) {
  const rows = await db
    .prepare(`SELECT standard, edition_year, language, sha256, adopted_at FROM publication_adoptions WHERE revoked_at IS NULL ORDER BY id`)
    .all<{ standard: string; edition_year: number; language: string; sha256: string; adopted_at: string }>();
  return rows.results;
}
