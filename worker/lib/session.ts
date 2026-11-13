import { resolveAuthority } from "./authority.ts";
import { verifyAccessIdentity } from "./access.ts";
import { isLoopbackHost } from "./host.ts";
import { oidcConfig, randomToken, sha256b64url } from "./oidc.ts";
import type { AccessIdentity, Env, Session } from "./types.ts";

export { isLoopbackHost } from "./host.ts";

export function stubEnabled(request: Request, env: Env): boolean {
  return env.AUTH_MODE === "stub" && isLoopbackHost(new URL(request.url).hostname);
}

/** Thrown when AUTH_MODE=stub is configured on a non-loopback host. */
export class StubMisconfigured extends Error {}

function guardStubConfig(request: Request, env: Env): void {
  if (env.AUTH_MODE === "stub" && !stubEnabled(request, env)) {
    throw new StubMisconfigured("AUTH_MODE=stub is only permitted on loopback hosts");
  }
}

export const SESSION_COOKIE = "__Host-ituob_session";
export const IDLE_MS = 24 * 60 * 60 * 1000;
export const ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
export const TOUCH_MS = 5 * 60 * 1000;
export const ROTATE_MS = 30 * 60 * 1000;
export const GRACE_MS = 60 * 1000;

const iso = (ms: number) => new Date(ms).toISOString();

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export const sessionCookie = (token: string) =>
  `${SESSION_COOKIE}=${token}; Max-Age=${ABSOLUTE_MS / 1000}; Path=/; Secure; HttpOnly; SameSite=Lax`;
export const clearedSessionCookie = () => `${SESSION_COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`;

/** Cookies a rotation wants on the response; the router attaches them. */
const pendingCookies = new WeakMap<Request, string>();
export function takePendingSessionCookie(request: Request): string | null {
  return pendingCookies.get(request) ?? null;
}

/** Create a session for a user and return the cookie token (only its hash is stored). */
export async function createSession(db: D1Database, userId: string): Promise<string> {
  const token = randomToken(32);
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO sessions (id, user_id, token_hash, rotated_at, created_at, last_seen_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?4, ?4, ?5)`,
    )
    .bind(randomToken(16), userId, await sha256b64url(token), iso(now), iso(now + ABSOLUTE_MS))
    .run();
  return token;
}

/** Delete the session a cookie token names (current or in-grace previous token). */
export async function destroySession(db: D1Database, token: string): Promise<void> {
  const h = await sha256b64url(token);
  await db.prepare(`DELETE FROM sessions WHERE token_hash = ?1 OR prev_token_hash = ?1`).bind(h).run();
}

interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  prev_token_hash: string | null;
  rotated_at: string;
  rotate_due: number;
  last_seen_at: string;
  expires_at: string;
}

async function oidcSession(request: Request, env: Env): Promise<Session | null> {
  if (!oidcConfig(env)) return null; // missing/invalid config fails closed
  const token = readCookie(request, SESSION_COOKIE);
  if (!token || token.length > 128) return null;
  const hash = await sha256b64url(token);
  const row = await env.DB
    .prepare(
      `SELECT s.id, s.user_id, s.token_hash, s.prev_token_hash, s.rotated_at, s.last_seen_at, s.expires_at,
              (EXISTS (SELECT 1 FROM membership_events e WHERE e.subject_id = s.user_id AND e.at > s.rotated_at)
               OR EXISTS (SELECT 1 FROM memberships m JOIN members ms ON ms.id = m.member_id
                           WHERE m.user_id = s.user_id AND ms.updated_at > s.rotated_at)) AS rotate_due
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?1 OR s.prev_token_hash = ?1`,
    )
    .bind(hash)
    .first<SessionRow>();
  if (!row) return null;
  const now = Date.now();
  const viaPrev = row.token_hash !== hash;
  if (viaPrev && now - Date.parse(row.rotated_at) > GRACE_MS) return null; // grace over
  if (now >= Date.parse(row.expires_at) || now - Date.parse(row.last_seen_at) >= IDLE_MS) {
    await env.DB.prepare(`DELETE FROM sessions WHERE id = ?1`).bind(row.id).run();
    return null;
  }
  const due = row.rotate_due === 1 || now - Date.parse(row.rotated_at) >= ROTATE_MS;
  if (!viaPrev && due) {
    const next = randomToken(32);
    // Conditional on the current hash: a concurrent rotation wins, this one is skipped.
    const r = await env.DB
      .prepare(
        `UPDATE sessions SET token_hash = ?1, prev_token_hash = ?2, rotated_at = ?3, last_seen_at = ?3
          WHERE id = ?4 AND token_hash = ?2`,
      )
      .bind(await sha256b64url(next), hash, iso(now), row.id)
      .run();
    if (r.meta.changes === 1) pendingCookies.set(request, sessionCookie(next));
  } else if (now - Date.parse(row.last_seen_at) >= TOUCH_MS) {
    await env.DB.prepare(`UPDATE sessions SET last_seen_at = ?1 WHERE id = ?2`).bind(iso(now), row.id).run();
  }
  // Roles and memberStateId are never stored in the session: read from D1 now.
  return { userId: row.user_id, ...(await resolveAuthority(env.DB, row.user_id)) };
}

/**
 * The seam every authorization check goes through (#102). Returns null for
 * no/invalid/expired session. Never throws for an unauthenticated request
 * (except the stub-on-production misconfiguration guard).
 *
 * AUTH_MODE="oidc": cookie -> sessions -> users, roles from D1 per call.
 * AUTH_MODE="stub" (loopback only): header `X-Stub-Session: <users.id>` names
 * an existing users row; roles are still resolved by resolveAuthority.
 * Anything else fails closed to null.
 */
export async function getSession(request: Request, env: Env): Promise<Session | null> {
  guardStubConfig(request, env);
  if (env.AUTH_MODE === "oidc") return oidcSession(request, env);
  if (!stubEnabled(request, env)) return null;
  const userId = request.headers.get("X-Stub-Session");
  if (!userId) return null;
  const user = await env.DB.prepare(`SELECT id FROM users WHERE id = ?1`).bind(userId).first();
  if (!user) return null;
  return { userId, ...(await resolveAuthority(env.DB, userId)) };
}

/**
 * Access seam: the verified Cf-Access-Jwt-Assertion identity. Verification
 * against the configured team JWKS is required outside the loopback stub.
 * Neither a bare email header nor an ordinary member session grants Access.
 */
export async function getAccessIdentity(
  request: Request,
  env: Env,
): Promise<AccessIdentity | null> {
  guardStubConfig(request, env);
  if (!stubEnabled(request, env)) return verifyAccessIdentity(request, env);
  const email = request.headers.get("X-Stub-Access");
  return email ? { email } : null;
}
