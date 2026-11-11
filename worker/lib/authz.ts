import type { Role, Session } from "./types.ts";

export class Forbidden extends Error {}

export function hasRole(session: Session | null, role: Role): boolean {
  return !!session && session.roles.includes(role);
}

export function isItu(session: Session | null): boolean {
  return hasRole(session, "itu-admin") || hasRole(session, "itu-editor");
}

export function requireRole(session: Session | null, ...roles: Role[]): Session {
  if (!session || !roles.some((r) => session.roles.includes(r))) throw new Forbidden();
  return session;
}

/**
 * Country binding for submissions. `registerKeys` are the country/area values
 * extracted server-side from the parsed payload (never a client-supplied member
 * id). Every key is resolved through members.register_key; the WHOLE submission
 * is refused if any key is unresolvable or resolves to another state than the
 * member-submitter's own. ITU editors/admins may submit for any resolvable or
 * unresolvable (non-ITU area) key. Returns the affiliation snapshot to write.
 */
export interface AffiliationSnapshot {
  submitted_by: string;
  affiliation_kind: "itu" | "member";
  affiliation_member_id: string | null;
}

export async function authorizeEntries(
  db: D1Database,
  session: Session | null,
  registerKeys: string[],
): Promise<AffiliationSnapshot> {
  if (!session || registerKeys.length === 0) throw new Forbidden();
  if (isItu(session)) {
    return { submitted_by: session.userId, affiliation_kind: "itu", affiliation_member_id: null };
  }
  if (!hasRole(session, "member-submitter") || !session.memberStateId) throw new Forbidden();
  for (const key of new Set(registerKeys)) {
    const m = await db
      .prepare(`SELECT id FROM members WHERE register_key = ?1`)
      .bind(key)
      .first<{ id: string }>();
    if (!m || m.id !== session.memberStateId) throw new Forbidden();
  }
  return {
    submitted_by: session.userId,
    affiliation_kind: "member",
    affiliation_member_id: session.memberStateId,
  };
}
