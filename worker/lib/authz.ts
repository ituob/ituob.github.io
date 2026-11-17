import { countryMemberId } from "./country-member.ts";
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
 * id). Every key is resolved through the shared country mapping (or a locally
 * reviewed exact register_key for administrations outside the seed); the WHOLE submission
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
    const mappedId = countryMemberId(key);
    if (mappedId && mappedId !== session.memberStateId) throw new Forbidden();
    // Include exact local keys to preserve reviewed administrations outside the bootstrap.
    // A conflicting local key must fail closed rather than silently select one member.
    const matches: D1Result<{ id: string }> = await db
      .prepare(`SELECT id FROM members WHERE register_key = ?1 OR id = ?2`)
      .bind(key, mappedId)
      .all<{ id: string }>();
    if (matches.results.length !== 1 || matches.results[0].id !== session.memberStateId) throw new Forbidden();
  }
  return {
    submitted_by: session.userId,
    affiliation_kind: "member",
    affiliation_member_id: session.memberStateId,
  };
}
