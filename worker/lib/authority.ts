import type { Role, Session } from "./types.ts";

/**
 * Resolve a user's authority from D1 at call time (docs/membership-roles.adoc,
 * "getSession contribution"). Roles are never cached in a session.
 *
 * - no active membership            -> roles [], memberStateId null (inert)
 * - active kind='itu'               -> the user's itu-* role rows
 * - active kind='member', state active -> ['member-submitter'] bound to the state
 * - active kind='member', state suspended/withdrawn -> no roles
 * Role rows that do not match their membership kind are inert.
 */
export async function resolveAuthority(
  db: D1Database,
  userId: string,
): Promise<Pick<Session, "roles" | "memberStateId">> {
  const m = await db
    .prepare(
      `SELECT m.kind AS kind, m.member_id AS member_id, ms.status AS member_status
         FROM memberships m LEFT JOIN members ms ON ms.id = m.member_id
        WHERE m.user_id = ?1 AND m.status = 'active'`,
    )
    .bind(userId)
    .first<{ kind: "itu" | "member"; member_id: string | null; member_status: string | null }>();
  if (!m) return { roles: [], memberStateId: null };

  const rows = await db
    .prepare(`SELECT role FROM user_roles WHERE user_id = ?1`)
    .bind(userId)
    .all<{ role: Role }>();
  const held = new Set(rows.results.map((r) => r.role));

  if (m.kind === "itu") {
    const roles = (["itu-admin", "itu-editor"] as const).filter((r) => held.has(r));
    return { roles: [...roles], memberStateId: null };
  }
  if (m.member_status === "active" && m.member_id && held.has("member-submitter")) {
    return { roles: ["member-submitter"], memberStateId: m.member_id };
  }
  return { roles: [], memberStateId: null };
}
