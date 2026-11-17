import type { Role } from "./types.ts";

export class ConflictError extends Error {}
export class NotFoundError extends Error {}
export class InvalidError extends Error {}

const now = () => new Date().toISOString();
const MAX_PENDING_PER_STATE = 20;

function event(
  db: D1Database,
  ev: string,
  subjectId: string | null,
  membershipId: number | null,
  detail: Record<string, unknown>,
  actorId: string | null = null,
) {
  return db
    .prepare(
      `INSERT INTO membership_events (at, actor_id, subject_id, membership_id, event, detail)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
    .bind(now(), actorId, subjectId, membershipId, ev, JSON.stringify(detail));
}

/** Member-facing: create a *pending* claim. Never activates, takes no status/role. */
export async function claimMembership(
  db: D1Database,
  userId: string,
  memberId: string,
  note: string | null,
): Promise<number> {
  const member = await db
    .prepare(`SELECT status FROM members WHERE id = ?1`)
    .bind(memberId)
    .first<{ status: string }>();
  if (!member) throw new NotFoundError("unknown member state");
  if (member.status !== "active") throw new InvalidError("member state is not active");
  const pending = await db
    .prepare(`SELECT count(*) AS n FROM memberships WHERE member_id = ?1 AND status = 'pending'`)
    .bind(memberId)
    .first<{ n: number }>();
  if ((pending?.n ?? 0) >= MAX_PENDING_PER_STATE) throw new ConflictError("too many pending claims");
  const t = now();
  try {
    const r = await db
      .prepare(
        `INSERT INTO memberships (user_id, kind, member_id, status, claimed_at, claim_note, created_at)
         VALUES (?1, 'member', ?2, 'pending', ?3, ?4, ?3)`,
      )
      .bind(userId, memberId, t, note)
      .run();
    const id = r.meta.last_row_id;
    await event(db, "claimed", userId, id, { memberId }, userId).run();
    return id;
  } catch (e) {
    // memberships_one_live is the final guard against a second live affiliation.
    if (String(e).includes("UNIQUE")) throw new ConflictError("account already has a live membership");
    throw e;
  }
}

export async function listClaims(db: D1Database, status: string) {
  const r = await db
    .prepare(
      `SELECT m.id, m.user_id, u.email, m.member_id, m.status, m.claimed_at, m.claim_note
         FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.kind = 'member' AND m.status = ?1 ORDER BY m.id`,
    )
    .bind(status)
    .all();
  return r.results;
}

async function getMembership(db: D1Database, id: number) {
  const m = await db
    .prepare(`SELECT id, user_id, kind, member_id, status FROM memberships WHERE id = ?1`)
    .bind(id)
    .first<{ id: number; user_id: string; kind: string; member_id: string | null; status: string }>();
  if (!m) throw new NotFoundError("unknown membership");
  return m;
}

/** ITU verification (Access-guarded caller). pending -> active + member-submitter role. */
export async function verifyClaim(db: D1Database, id: number, accessEmail: string, note: string | null) {
  const m = await getMembership(db, id);
  if (m.kind !== "member" || m.status !== "pending") throw new ConflictError("not a pending member claim");
  const t = now();
  const res = await db.batch([
    db
      .prepare(
        `UPDATE memberships SET status='active', decided_at=?2, decision_note=?3
          WHERE id=?1 AND status='pending'`,
      )
      .bind(id, t, note),
    db
      .prepare(
        `INSERT OR IGNORE INTO user_roles (user_id, role, granted_by, granted_at)
         SELECT ?2, 'member-submitter', NULL, ?3 WHERE EXISTS
           (SELECT 1 FROM memberships WHERE id=?1 AND status='active')`,
      )
      .bind(id, m.user_id, t),
    event(db, "verified", m.user_id, id, { access: accessEmail, note }),
  ]);
  if (res[0]?.meta.changes !== 1) throw new ConflictError("claim no longer pending");
}

export async function rejectClaim(db: D1Database, id: number, accessEmail: string, note: string | null) {
  const m = await getMembership(db, id);
  if (m.kind !== "member" || m.status !== "pending") throw new ConflictError("not a pending member claim");
  const res = await db.batch([
    db
      .prepare(`UPDATE memberships SET status='rejected', decided_at=?2, decision_note=?3 WHERE id=?1 AND status='pending'`)
      .bind(id, now(), note),
    event(db, "rejected", m.user_id, id, { access: accessEmail, note }),
  ]);
  if (res[0]?.meta.changes !== 1) throw new ConflictError("claim no longer pending");
}

/** Blocks new actions at the next request; history rows are untouched. */
export async function deactivateMembership(db: D1Database, id: number, accessEmail: string, note: string | null) {
  const m = await getMembership(db, id);
  if (m.status !== "active") throw new ConflictError("membership is not active");
  const res = await db.batch([
    db
      .prepare(`UPDATE memberships SET status='deactivated', decided_at=?2, decision_note=?3 WHERE id=?1 AND status='active'`)
      .bind(id, now(), note),
    event(db, "deactivated", m.user_id, id, { access: accessEmail, note }),
  ]);
  if (res[0]?.meta.changes !== 1) throw new ConflictError("membership no longer active");
}

/** ITU staff are provisioned directly, never claimed. accessEmail null = seed/bootstrap. */
export async function provisionItuStaff(
  db: D1Database,
  userId: string,
  roles: string[],
  accessEmail: string | null,
): Promise<number> {
  const allowed = ["itu-admin", "itu-editor"] as const;
  if (roles.length === 0 || !roles.every((r): r is (typeof allowed)[number] => (allowed as readonly string[]).includes(r)))
    throw new InvalidError("roles must be a non-empty subset of itu-admin, itu-editor");
  const user = await db.prepare(`SELECT id FROM users WHERE id=?1`).bind(userId).first();
  if (!user) throw new NotFoundError("unknown user (must have logged in once)");
  const t = now();
  let id: number;
  try {
    const r = await db
      .prepare(
        `INSERT INTO memberships (user_id, kind, member_id, status, decided_at, created_at)
         VALUES (?1, 'itu', NULL, 'active', ?2, ?2)`,
      )
      .bind(userId, t)
      .run();
    id = r.meta.last_row_id;
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new ConflictError("account already has a live membership");
    throw e;
  }
  await db.batch([
    ...roles.map((role: Role | string) =>
      db
        .prepare(`INSERT OR IGNORE INTO user_roles (user_id, role, granted_by, granted_at) VALUES (?1, ?2, NULL, ?3)`)
        .bind(userId, role, t),
    ),
    event(db, "provisioned", userId, id, { access: accessEmail, roles }),
  ]);
  return id;
}

export async function setMemberStatus(db: D1Database, memberId: string, status: string, accessEmail: string) {
  if (!["active", "suspended", "withdrawn"].includes(status)) throw new InvalidError("bad status");
  const r = await db
    .prepare(`UPDATE members SET status=?2, updated_at=?3 WHERE id=?1`)
    .bind(memberId, status, now())
    .run();
  if (r.meta.changes !== 1) throw new NotFoundError("unknown member state");
  await event(db, "member_status", null, null, { memberId, status, access: accessEmail }).run();
}

export interface RosterRow {
  id: string;
  name: string;
  register_key: string;
  iso3166_alpha2?: string | null;
  itu_identifier?: string | null;
  member_since?: string | null;
  status?: "active" | "suspended" | "withdrawn";
}

/**
 * Roster import: idempotent upsert. Members absent from the list are
 * *reported* (missing), never deleted and never status-changed here.
 */
export async function importRoster(db: D1Database, rows: RosterRow[], dryRun: boolean, accessEmail: string) {
  const existing = new Map(
    (await db.prepare(`SELECT id, name, register_key, status FROM members`).all<{
      id: string; name: string; register_key: string; status: string;
    }>()).results.map((m) => [m.id, m]),
  );
  const added: string[] = [], changed: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.id || !r.name || !r.register_key) throw new InvalidError("id, name, register_key are required");
    if (seen.has(r.id)) throw new InvalidError(`duplicate id ${r.id}`);
    seen.add(r.id);
    const e = existing.get(r.id);
    if (!e) added.push(r.id);
    else if (e.name !== r.name || e.register_key !== r.register_key || (r.status && e.status !== r.status)) changed.push(r.id);
  }
  const missing = [...existing.keys()].filter((id) => !seen.has(id));
  if (!dryRun) {
    const t = now();
    const stmts = rows.map((r) =>
      db
        .prepare(
          `INSERT INTO members (id, name, register_key, iso3166_alpha2, itu_identifier, status, member_since, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
           ON CONFLICT(id) DO UPDATE SET name=excluded.name, register_key=excluded.register_key,
             iso3166_alpha2=excluded.iso3166_alpha2, itu_identifier=excluded.itu_identifier,
             status=excluded.status, member_since=excluded.member_since, updated_at=excluded.updated_at`,
        )
        .bind(r.id, r.name, r.register_key, r.iso3166_alpha2 ?? null, r.itu_identifier ?? null, r.status ?? "active", r.member_since ?? null, t),
    );
    stmts.push(event(db, "roster_import", null, null, { access: accessEmail, added, changed, missing }));
    await db.batch(stmts);
  }
  return { dry_run: dryRun, added, changed, missing };
}
