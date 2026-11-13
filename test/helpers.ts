import { env, exports } from "cloudflare:workers";
import { authorizeEntries, Forbidden } from "../worker/lib/authz.ts";
import { provisionItuStaff } from "../worker/lib/membership.ts";
import { getSession } from "../worker/lib/session.ts";

export const db = () => env.DB;
const T = "2026-01-01T00:00:00.000Z";

export async function seedMembers() {
  for (const [id, key] of [["A", "Aland"], ["B", "Bland"]] as const) {
    await db()
      .prepare("INSERT INTO members (id,name,register_key,status,created_at,updated_at) VALUES (?1,?2,?3,'active',?4,?4)")
      .bind(id, `${key} (Republic)`, key, T)
      .run();
  }
}

export async function addUser(id: string) {
  await db().prepare("INSERT INTO users (id,email,created_at) VALUES (?1,?2,?3)").bind(id, `${id}@example.test`, T).run();
}

/** Fixture accounts from the #102 note, built through the real endpoints/helpers where possible. */
export async function seedFixtures() {
  await seedMembers();
  for (const u of ["itu-admin", "itu-editor", "member-A", "member-B", "unaffiliated", "deactivated-member-A"]) await addUser(u);
  await bootstrapAdmin();
}

export async function api(method: string, path: string, opts: { session?: string; access?: string; body?: unknown; host?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.session) headers["X-Stub-Session"] = opts.session;
  if (opts.access) headers["X-Stub-Access"] = opts.access;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && !headers["Sec-Fetch-Site"]) headers["Sec-Fetch-Site"] = "same-origin";
  const res = await exports.default.fetch(
    new Request(`http://${opts.host ?? "localhost"}${path}`, { method, headers, body: opts.body === undefined || method === "GET" ? undefined : JSON.stringify(opts.body) }),
  );
  let json: any = null;
  try { json = await res.clone().json(); } catch {}
  return { status: res.status, json };
}

export const ADMIN = "admin@itu.example";
export const BOOTSTRAP_ADMIN_ID = "bootstrap-admin";

/** Operator bootstrap in real D1, never authority derived from an HTTP header. */
export async function bootstrapAdmin() {
  const existing = await db().prepare("SELECT id FROM users WHERE id=?1").bind(BOOTSTRAP_ADMIN_ID).first();
  if (existing) return; // Do not silently restore an administrator revoked by a test.
  await db().prepare("INSERT INTO users (id,email,created_at) VALUES (?1,?2,?3)").bind(BOOTSTRAP_ADMIN_ID, ADMIN, T).run();
  await provisionItuStaff(db(), BOOTSTRAP_ADMIN_ID, ["itu-admin"], null);
}

/** claim -> admin verify, via the real endpoints. Returns membership id. */
export async function activateMember(user: string, memberId: string) {
  await bootstrapAdmin();
  const c = await api("POST", "/api/me/membership/claim", { session: user, body: { memberId, note: "TSB contact" } });
  if (c.status !== 201) throw new Error(`claim failed ${c.status}`);
  const v = await api("POST", `/api/admin/claims/${c.json.membershipId}/verify`, { access: ADMIN, body: {} });
  if (v.status !== 200) throw new Error(`verify failed ${v.status}`);
  return c.json.membershipId as number;
}

export async function provisionItu(user: string, roles: string[]) {
  await bootstrapAdmin();
  const r = await api("POST", "/api/admin/itu-staff", { access: ADMIN, body: { userId: user, roles } });
  if (r.status !== 201) throw new Error(`provision failed ${r.status}`);
  return r.json.membershipId as number;
}

/**
 * Minimal #103 stand-in: a submission handler that uses the real enforcement
 * helper (country keys are given server-side, as the handler would derive them
 * from the parsed payload) and writes the affiliation snapshot atomically.
 */
export async function submit(sessionUser: string, keys: string[]): Promise<number> {
  const session = await getSession(
    new Request("http://localhost/x", { headers: { "X-Stub-Session": sessionUser } }),
    env as any,
  );
  const snap = await authorizeEntries(db(), session, keys); // throws Forbidden before any write
  const res = await db().batch(
    keys.map((k) =>
      db()
        .prepare("INSERT INTO test_submissions (submitted_by,affiliation_kind,affiliation_member_id,register_key) VALUES (?1,?2,?3,?4)")
        .bind(snap.submitted_by, snap.affiliation_kind, snap.affiliation_member_id, k),
    ),
  );
  return res.length;
}
export { Forbidden };
