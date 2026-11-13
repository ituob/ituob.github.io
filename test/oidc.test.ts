import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import worker from "../worker/index.ts";
import { getAccessIdentity, getSession, ABSOLUTE_MS, GRACE_MS, IDLE_MS, ROTATE_MS } from "../worker/lib/session.ts";
import { resetOidcCaches, b64url } from "../worker/lib/oidc.ts";
import { ADMIN, bootstrapAdmin, activateMember, addUser, db, provisionItu, seedMembers } from "./helpers.ts";
import { CLIENT_ID, CLIENT_SECRET, ISSUER, MockIdp } from "./mock-idp.ts";

const BASE: Record<string, unknown> = {
  AUTH_MODE: "oidc",
  OIDC_ISSUER: ISSUER,
  OIDC_CLIENT_ID: CLIENT_ID,
  OIDC_CLIENT_SECRET: CLIENT_SECRET,
};
const mkEnv = (extra: Record<string, unknown> = {}) => ({ ...env, ...BASE, ...extra }) as any;

/** A minimal browser: cookie jar + manual redirect handling. */
class Browser {
  jar = new Map<string, string>();
  constructor(public e = mkEnv(), public host = "localhost") {}
  async fetch(path: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.jar.size) headers.set("Cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const method = init.method ?? "GET";
    if (method !== "GET" && !headers.has("Sec-Fetch-Site")) headers.set("Sec-Fetch-Site", "same-origin");
    const res = await worker.fetch(new Request(new URL(path, `http://${this.host}`).toString(), { ...init, headers, redirect: "manual" }), this.e);
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(";");
      const i = pair!.indexOf("=");
      const name = pair!.slice(0, i), val = pair!.slice(i + 1);
      if (val === "" || attrs.some((a) => a.trim().toLowerCase() === "max-age=0")) this.jar.delete(name);
      else this.jar.set(name, val);
    }
    return res;
  }
  async whoami() {
    const r = await this.fetch("/api/whoami");
    return { res: r, json: (await r.json()) as any };
  }
}

const idp = new MockIdp();
beforeEach(async () => { await idp.start(); idp.overrides = {}; idp.tamper = null; idp.signWith = null; idp.down = false; });
afterEach(() => idp.stop());

/** Full login through the mock IdP. Returns the final redirect response. */
async function login(b: Browser, returnTo = "/", claims?: Record<string, unknown>) {
  const start = await b.fetch(`/auth/login?return_to=${encodeURIComponent(returnTo)}`);
  expect(start.status).toBe(302);
  const cb = await idp.authorize(start.headers.get("Location")!, claims);
  return b.fetch(cb.pathname + cb.search);
}
const SESSION = "__Host-ituob_session";
const sessionRows = () => db().prepare("SELECT * FROM sessions").all<any>().then((r) => r.results);

describe("premise: the mock OIDC provider runs inside the workers pool", () => {
  it("serves discovery and JWKS by intercepting outbound fetch", async () => {
    const d = await (await fetch(`${ISSUER}/.well-known/openid-configuration`)).json<any>();
    expect(d.issuer).toBe(ISSUER);
    expect((await (await fetch(d.jwks_uri)).json<any>()).keys[0].kid).toBe("k1");
  });
});

describe("login -> whoami -> pages -> logout", () => {
  it("runs the whole flow and keeps the session across pages", async () => {
    const b = new Browser();
    expect((await b.whoami()).json).toMatchObject({ ok: true, authenticated: false });

    const start = await b.fetch("/auth/login?return_to=/register/2026");
    const loc = new URL(start.headers.get("Location")!);
    expect(loc.origin + loc.pathname).toBe(`${ISSUER}/authorize`);
    expect(Object.fromEntries(loc.searchParams)).toMatchObject({
      response_type: "code", client_id: CLIENT_ID, scope: "openid email profile",
      redirect_uri: "http://localhost/auth/callback", code_challenge_method: "S256",
    });
    expect(loc.searchParams.get("state")!.length).toBeGreaterThan(20);
    expect(loc.searchParams.get("nonce")!.length).toBeGreaterThan(20);
    const flowCookie = start.headers.getSetCookie()[0]!;
    expect(flowCookie).toMatch(/^__Host-ituob_flow=.+; Max-Age=600; Path=\/; Secure; HttpOnly; SameSite=Lax$/);
    expect((await db().prepare("SELECT count(*) n FROM oidc_flows").first<any>()).n).toBe(1);

    const cb = await idp.authorize(start.headers.get("Location")!);
    const done = await b.fetch(cb.pathname + cb.search);
    expect(done.status).toBe(302);
    expect(done.headers.get("Location")).toBe("/register/2026");
    const sc = done.headers.getSetCookie().find((c) => c.startsWith(SESSION))!;
    expect(sc).toMatch(/Path=\/; Secure; HttpOnly; SameSite=Lax/);
    expect(sc).not.toMatch(/Domain/i);
    // PKCE + confidential client auth reached the token endpoint.
    expect(idp.tokenRequests[0]!.body.get("code_verifier")!.length).toBeGreaterThanOrEqual(43);
    expect(idp.tokenRequests[0]!.auth).toMatch(/^Basic /);
    // Flow consumed.
    expect((await db().prepare("SELECT count(*) n FROM oidc_flows").first<any>()).n).toBe(0);

    // first-login upsert by sub; account is authenticated but unauthorized
    const u = await db().prepare("SELECT * FROM users").all<any>();
    expect(u.results).toHaveLength(1);
    expect(u.results[0]).toMatchObject({ id: "idp-user-1", email: "u1@example.test", display_name: "User One" });
    const w = await b.whoami();
    expect(w.json).toMatchObject({ authenticated: true, userId: "idp-user-1", roles: [], memberStateId: null, user: { id: "idp-user-1", displayName: "User One" } });
    expect(w.res.headers.get("Cache-Control")).toBe("no-store");

    // page-to-page: several requests, one session
    for (let i = 0; i < 3; i++) expect((await b.whoami()).json.authenticated).toBe(true);
    expect(await sessionRows()).toHaveLength(1);

    // only the hash is stored
    const token = b.jar.get(SESSION)!;
    const row = (await sessionRows())[0];
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.token_hash).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // logout
    const out = await b.fetch("/auth/logout", { method: "POST" });
    expect(out.status).toBe(303);
    expect(out.headers.get("Location")).toBe("/");
    expect(out.headers.getSetCookie().find((c) => c.startsWith(SESSION))).toMatch(/Max-Age=0/);
    expect(await sessionRows()).toHaveLength(0);
    expect((await b.whoami()).json.authenticated).toBe(false);
    // the old cookie is dead server-side, not just cleared client-side
    const stale = new Browser(); stale.jar.set(SESSION, token);
    expect((await stale.whoami()).json.authenticated).toBe(false);
  });

  it("second login by the same sub reuses the users row and refreshes profile", async () => {
    await login(new Browser());
    await login(new Browser(), "/", { ...idp.profile, name: "Renamed" });
    const u = await db().prepare("SELECT * FROM users").all<any>();
    expect(u.results).toHaveLength(1);
    expect(u.results[0].display_name).toBe("Renamed");
  });

  it("never merges accounts by email", async () => {
    await login(new Browser(), "/", { sub: "a", email: "same@example.test" });
    await login(new Browser(), "/", { sub: "b", email: "same@example.test" });
    expect((await db().prepare("SELECT count(*) n FROM users").first<any>()).n).toBe(2);
  });

  it("logout requires same-origin and a POST; cross-site logout leaves the session", async () => {
    const b = new Browser(); await login(b);
    expect((await b.fetch("/auth/logout", { method: "POST", headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
    expect((await b.fetch("/auth/logout")).status).toBe(405);
    expect((await b.whoami()).json.authenticated).toBe(true);
  });

  it("RP-initiated logout only when end_session_endpoint is configured", async () => {
    const b = new Browser(mkEnv({ OIDC_END_SESSION_ENDPOINT: `${ISSUER}/logout` })); await login(b);
    const out = await b.fetch("/auth/logout", { method: "POST" });
    const l = new URL(out.headers.get("Location")!);
    expect(l.origin + l.pathname).toBe(`${ISSUER}/logout`);
    expect(l.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(await sessionRows()).toHaveLength(0);
  });

  it("return_to is a path, never a URL", async () => {
    for (const bad of ["https://evil.example/", "//evil.example", "/\\evil.example", "javascript:alert(1)", "/a\r\nSet-Cookie: x=y"]) {
      const b = new Browser();
      const r = await login(b, bad);
      expect(r.headers.get("Location"), bad).toBe("/");
    }
  });

  it("a pre-existing session cookie is discarded at login (fixation)", async () => {
    const b = new Browser(); await login(b);
    const first = b.jar.get(SESSION)!;
    await login(b);
    expect(b.jar.get(SESSION)).not.toBe(first);
    const old = new Browser(); old.jar.set(SESSION, first);
    expect((await old.whoami()).json.authenticated).toBe(false);
    expect(await sessionRows()).toHaveLength(1);
  });
});

describe("callback rejects bad flows and bad ID tokens", () => {
  async function startFlow(b: Browser) {
    const start = await b.fetch("/auth/login");
    return idp.authorize(start.headers.get("Location")!);
  }
  const assertNoSession = async (b: Browser) => {
    expect(await sessionRows()).toHaveLength(0);
    expect((await b.whoami()).json.authenticated).toBe(false);
    expect((await db().prepare("SELECT count(*) n FROM users").first<any>()).n).toBe(0);
  };

  it("replayed state/callback is refused (flow is single use)", async () => {
    const b = new Browser();
    const cb = await startFlow(b);
    const flowCookie = b.jar.get("__Host-ituob_flow")!;
    expect((await b.fetch(cb.pathname + cb.search)).status).toBe(302);
    const replay = new Browser(); replay.jar.set("__Host-ituob_flow", flowCookie);
    expect((await replay.fetch(cb.pathname + cb.search)).status).toBe(400);
  });

  it("state mismatch is refused and consumes the flow", async () => {
    const b = new Browser();
    const cb = await startFlow(b);
    cb.searchParams.set("state", "forged");
    expect((await b.fetch(cb.pathname + cb.search)).status).toBe(400);
    expect((await db().prepare("SELECT count(*) n FROM oidc_flows").first<any>()).n).toBe(0);
    await assertNoSession(b);
  });

  it("callback without the flow cookie is refused (login CSRF / code injection)", async () => {
    const victim = new Browser();
    const cb = await startFlow(victim);
    const attacker = new Browser();
    expect((await attacker.fetch(cb.pathname + cb.search)).status).toBe(400);
    expect(idp.tokenRequests).toHaveLength(0);
  });

  it("an expired flow is refused before any token call", async () => {
    const b = new Browser();
    const cb = await startFlow(b);
    await db().prepare("UPDATE oidc_flows SET created_at = ?1").bind(new Date(Date.now() - 11 * 60_000).toISOString()).run();
    expect((await b.fetch(cb.pathname + cb.search)).status).toBe(400);
    expect(idp.tokenRequests).toHaveLength(0);
    await assertNoSession(b);
  });

  it("an IdP error response is refused", async () => {
    const b = new Browser();
    const cb = await startFlow(b);
    const url = `/auth/callback?error=access_denied&state=${cb.searchParams.get("state")}`;
    expect((await b.fetch(url)).status).toBe(400);
    await assertNoSession(b);
  });

  const cases: [string, () => void][] = [
    ["wrong iss", () => { idp.overrides = { iss: "https://other.example" }; }],
    ["wrong aud", () => { idp.overrides = { aud: "someone-else" }; }],
    ["aud list without azp", () => { idp.overrides = { aud: [CLIENT_ID, "other"] }; }],
    ["wrong nonce", () => { idp.overrides = { nonce: "not-the-nonce" }; }],
    ["missing nonce", () => { idp.overrides = { nonce: undefined }; }],
    ["expired", () => { idp.overrides = { exp: Math.floor(Date.now() / 1000) - 3600 }; }],
    ["issued in the future", () => { idp.overrides = { iat: Math.floor(Date.now() / 1000) + 3600 }; }],
    ["missing sub", () => { idp.overrides = { sub: undefined }; }],
    ["tampered payload", () => { idp.tamper = (t) => { const [h, p, s] = t.split("."); const c = JSON.parse(atob(p!.replace(/-/g, "+").replace(/_/g, "/"))); c.sub = "admin"; return `${h}.${b64url(new TextEncoder().encode(JSON.stringify(c)))}.${s}`; }; }],
    ["tampered signature", () => { idp.tamper = (t) => t.slice(0, -4) + (t.endsWith("AAAA") ? "BBBB" : "AAAA"); }],
    ["alg none", () => { idp.tamper = (t) => { const [, p] = t.split("."); const h = b64url(new TextEncoder().encode(JSON.stringify({ alg: "none", kid: "k1" }))); return `${h}.${p}.`; }; }],
    ["alg HS256", () => { idp.tamper = (t) => { const [, p, s] = t.split("."); const h = b64url(new TextEncoder().encode(JSON.stringify({ alg: "HS256", kid: "k1" }))); return `${h}.${p}.${s}`; }; }],
  ];
  for (const [name, setup] of cases) {
    it(`rejects an ID token with ${name}`, async () => {
      setup();
      const b = new Browser();
      const cb = await startFlow(b);
      const res = await b.fetch(cb.pathname + cb.search);
      expect(res.status).toBe(400);
      expect(res.headers.getSetCookie().some((c) => c.startsWith(SESSION))).toBe(false);
      await assertNoSession(b);
    });
  }

  it("rejects a token signed by a key not in the JWKS (unknown kid)", async () => {
    const rogue = await new MockIdp().addKey("rogue");
    idp.signWith = rogue;
    const b = new Browser();
    const cb = await startFlow(b);
    expect((await b.fetch(cb.pathname + cb.search)).status).toBe(400);
    await assertNoSession(b);
  });

  it("rejects a token whose kid names another key (signature by wrong key)", async () => {
    const other = await idp.addKey("k2");
    // k2 is in the JWKS, but sign with k1's private key under k2's kid
    const k1 = idp.keys[0]!;
    idp.signWith = { ...k1, kid: other.kid };
    const b = new Browser();
    const cb = await startFlow(b);
    expect((await b.fetch(cb.pathname + cb.search)).status).toBe(400);
    await assertNoSession(b);
  });

  it("follows a key rotation: unknown kid triggers one (rate-limited) JWKS refresh", async () => {
    const b0 = new Browser(); await login(b0); // primes the JWKS cache with k1 only
    idp.signWith = await idp.addKey("k2", "ES256");
    // Inside the 60 s refresh limit an unknown kid is refused ...
    const b1 = new Browser();
    expect((await login(b1)).status).toBe(400);
    // ... after it, the refresh picks up k2 and the login succeeds.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 2 * 60_000);
      const b = new Browser();
      expect((await login(b)).status).toBe(302);
      expect((await b.whoami()).json.authenticated).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("an unreachable identity service fails the login closed (502), no session", async () => {
    const b = new Browser();
    const cb = await startFlow(b);
    idp.down = true;
    const res = await b.fetch(cb.pathname + cb.search);
    expect(res.status).toBe(502);
    await assertNoSession(b);
  });

  it("a rejected token exchange (IdP says invalid_grant) creates no session", async () => {
    const b = new Browser();
    const cb = await startFlow(b);
    cb.searchParams.set("code", "forged-code");
    expect((await b.fetch(cb.pathname + cb.search)).status).toBe(502);
    await assertNoSession(b);
  });
});

describe("session lifetime and rotation", () => {
  const age = (ms: { created?: number; seen?: number; rotated?: number; expiresIn?: number }) => {
    const now = Date.now();
    return db().prepare(
      `UPDATE sessions SET created_at = ?1, last_seen_at = ?2, rotated_at = ?3, expires_at = ?4`,
    ).bind(
      new Date(now - (ms.created ?? 0)).toISOString(),
      new Date(now - (ms.seen ?? 0)).toISOString(),
      new Date(now - (ms.rotated ?? 0)).toISOString(),
      new Date(now + (ms.expiresIn ?? ABSOLUTE_MS)).toISOString(),
    ).run();
  };

  it("idle timeout: 24 h without use ends the session; just under keeps it", async () => {
    const b = new Browser(); await login(b);
    await age({ seen: IDLE_MS - 60_000 });
    expect((await b.whoami()).json.authenticated).toBe(true);
    await age({ seen: IDLE_MS + 1000 });
    expect((await b.whoami()).json.authenticated).toBe(false);
    expect(await sessionRows()).toHaveLength(0);
  });

  it("absolute lifetime: use does not extend past 7 days", async () => {
    const b = new Browser(); await login(b);
    await age({ created: ABSOLUTE_MS - 1000, expiresIn: 1000 * 60 });
    expect((await b.whoami()).json.authenticated).toBe(true);
    await age({ expiresIn: -1000 });
    expect((await b.whoami()).json.authenticated).toBe(false);
    expect(await sessionRows()).toHaveLength(0);
  });

  it("sliding: last_seen_at is bumped at most every 5 minutes", async () => {
    const b = new Browser(); await login(b);
    const t0 = (await sessionRows())[0].last_seen_at;
    await b.whoami();
    expect((await sessionRows())[0].last_seen_at).toBe(t0); // < 5 min: no write
    await age({ seen: 10 * 60_000, rotated: 10 * 60_000 });
    await b.whoami();
    expect(Date.parse((await sessionRows())[0].last_seen_at)).toBeGreaterThan(Date.now() - 5000);
  });

  it("rotates every 30 minutes; the previous token works for 60 s only", async () => {
    const b = new Browser(); await login(b);
    const t1 = b.jar.get(SESSION)!;
    await b.whoami();
    expect(b.jar.get(SESSION)).toBe(t1); // fresh: no rotation
    await age({ rotated: ROTATE_MS + 1000 });
    const w = await b.whoami();
    expect(w.json.authenticated).toBe(true);
    const t2 = b.jar.get(SESSION)!;
    expect(t2).not.toBe(t1);
    expect(w.res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION}=${t2}`))).toBe(true);
    // old token inside the grace window: still valid, and does not rotate again
    const parallel = new Browser(); parallel.jar.set(SESSION, t1);
    const pw = await parallel.whoami();
    expect(pw.json.authenticated).toBe(true);
    expect(pw.res.headers.getSetCookie()).toHaveLength(0);
    expect((await b.whoami()).json.authenticated).toBe(true);
    // past the grace window the old token is dead; the new one lives
    await db().prepare("UPDATE sessions SET rotated_at = ?1").bind(new Date(Date.now() - GRACE_MS - 1000).toISOString()).run();
    expect((await parallel.whoami()).json.authenticated).toBe(false);
    expect((await b.whoami()).json.authenticated).toBe(true);
    // rotation does not extend the absolute lifetime
    const row = (await sessionRows())[0];
    expect(Date.parse(row.expires_at) - Date.parse(row.created_at)).toBe(ABSOLUTE_MS);
  });

  it("rotates on the next request after a role/membership change", async () => {
    await seedMembers();
    const b = new Browser(); await login(b, "/", { sub: "m1", email: "m1@example.test" });
    const t1 = b.jar.get(SESSION)!;
    await b.whoami();
    expect(b.jar.get(SESSION)).toBe(t1);
    await activateMember("m1", "A");
    const w = await b.whoami();
    expect(b.jar.get(SESSION)).not.toBe(t1);
    expect(w.json).toMatchObject({ roles: ["member-submitter"], memberStateId: "A" });
  });
});

describe("authority comes from D1 per request", () => {
  it("claim, verify, deactivate take effect on the very next request, same session", async () => {
    await seedMembers();
    const b = new Browser(); await login(b, "/", { sub: "m1", email: "m1@example.test" });
    expect((await b.whoami()).json).toMatchObject({ roles: [], memberStateId: null });
    const claim = await b.fetch("/api/me/membership/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ memberId: "A" }) });
    expect(claim.status).toBe(201);
    expect((await b.whoami()).json.roles).toEqual([]); // pending is inert
    const id = (await claim.json<any>()).membershipId;
    await bootstrapAdmin();
    const v = await worker.fetch(new Request(`http://localhost/api/admin/claims/${id}/verify`, { method: "POST", headers: { "X-Stub-Access": ADMIN, "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" }, body: "{}" }), { ...env, AUTH_MODE: "stub" } as any);
    expect(v.status).toBe(200);
    expect((await b.whoami()).json).toMatchObject({ roles: ["member-submitter"], memberStateId: "A" });
    const d = await worker.fetch(new Request(`http://localhost/api/admin/memberships/${id}/deactivate`, { method: "POST", headers: { "X-Stub-Access": ADMIN, "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" }, body: "{}" }), { ...env, AUTH_MODE: "stub" } as any);
    expect(d.status).toBe(200);
    expect((await b.whoami()).json).toMatchObject({ authenticated: true, roles: [], memberStateId: null });
  });

  it("a suspended member state removes the role immediately", async () => {
    await seedMembers();
    const b = new Browser(); await login(b, "/", { sub: "m1" });
    await activateMember("m1", "A");
    expect((await b.whoami()).json.roles).toEqual(["member-submitter"]);
    await db().prepare("UPDATE members SET status='suspended' WHERE id='A'").run();
    expect((await b.whoami()).json.roles).toEqual([]);
  });

  it("deleting a user's sessions revokes them at once", async () => {
    const b = new Browser(); await login(b);
    await db().prepare("DELETE FROM sessions WHERE user_id = 'idp-user-1'").run();
    expect((await b.whoami()).json.authenticated).toBe(false);
  });
});

describe("Access stays the only trust path for admin routes", () => {
  it("a valid identity session never satisfies /api/admin/* (and a header stub is not honored in oidc mode)", async () => {
    const b = new Browser(); await login(b, "/", { sub: "staff" });
    await provisionItuSafe("staff");
    expect((await b.whoami()).json.roles).toEqual(["itu-admin"]);
    for (const [m, p] of [["GET", "/api/admin/claims"], ["POST", "/api/admin/itu-staff"], ["POST", "/api/admin/roster/import"]] as const) {
      const r = await b.fetch(p, { method: m, headers: { "Content-Type": "application/json", "X-Stub-Access": ADMIN }, body: m === "POST" ? "{}" : undefined });
      expect(r.status, p).toBe(403);
    }
    expect((await b.fetch("/api/admin/anything-else")).status).toBe(403);
  });
  async function provisionItuSafe(user: string) {
    await bootstrapAdmin();
    const stubEnv = { ...env, AUTH_MODE: "stub" } as any;
    const r = await worker.fetch(new Request("http://localhost/api/admin/itu-staff", { method: "POST", headers: { "X-Stub-Access": ADMIN, "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" }, body: JSON.stringify({ userId: user, roles: ["itu-admin"] }) }), stubEnv);
    expect(r.status).toBe(201);
  }

  it("the stub is impossible off loopback even when oidc config is also present", async () => {
    await addUser("u");
    const e = mkEnv({ AUTH_MODE: "stub" });
    for (const host of ["www.ituob.org", "staging-www.ituob.org", "evil.example"]) {
      const req = new Request(`https://${host}/api/whoami`, { headers: { "X-Stub-Session": "u", "X-Stub-Access": "a@b.c" } });
      await expect(getSession(req, e)).rejects.toThrow(/loopback/);
      await expect(getAccessIdentity(req, e)).rejects.toThrow(/loopback/);
      const res = await worker.fetch(req, e);
      expect(res.status).toBe(500);
    }
  });

  it("in stub mode /auth/* is 501, never a login", async () => {
    const b = new Browser(mkEnv({ AUTH_MODE: "stub" }));
    expect((await b.fetch("/auth/login")).status).toBe(501);
    expect((await b.fetch("/auth/callback?code=x&state=y")).status).toBe(501);
  });
});

describe("configuration fails closed", () => {
  const broken: [string, Record<string, unknown>][] = [
    ["no issuer", { OIDC_ISSUER: undefined }],
    ["no client id", { OIDC_CLIENT_ID: undefined }],
    ["no client secret", { OIDC_CLIENT_SECRET: undefined }],
    ["http issuer off loopback", { OIDC_ISSUER: "http://idp.mock.test" }],
    ["unknown client auth", { OIDC_CLIENT_AUTH: "magic" }],
    ["HS256 allowed", { OIDC_ID_TOKEN_ALGS: "HS256" }],
    ["http token endpoint off loopback", { OIDC_TOKEN_ENDPOINT: "http://idp.mock.test/token" }],
  ];
  for (const [name, patch] of broken) {
    it(`${name}: login is 503, and existing sessions stop working`, async () => {
      const b = new Browser(); await login(b);
      expect((await b.whoami()).json.authenticated).toBe(true);
      const bad = new Browser(mkEnv(patch)); bad.jar = b.jar;
      expect((await bad.fetch("/auth/login")).status).toBe(503);
      expect((await bad.fetch("/auth/callback?code=a&state=b")).status).toBe(503);
      expect((await bad.whoami()).json.authenticated).toBe(false);
    });
  }

  it("AUTH_MODE unset: no login, no session", async () => {
    const b = new Browser(mkEnv({ AUTH_MODE: undefined }));
    expect((await b.fetch("/auth/login")).status).toBe(503);
  });

  it("explicit endpoints skip discovery", async () => {
    const b = new Browser(mkEnv({ OIDC_AUTHORIZATION_ENDPOINT: `${ISSUER}/authorize`, OIDC_TOKEN_ENDPOINT: `${ISSUER}/token`, OIDC_JWKS_URI: `${ISSUER}/jwks` }));
    await login(b);
    expect(idp.calls.some((c) => c.url.includes(".well-known"))).toBe(false);
    expect((await b.whoami()).json.authenticated).toBe(true);
  });

  it("OIDC_SUB_KEY=issuer namespaces users.id", async () => {
    const b = new Browser(mkEnv({ OIDC_SUB_KEY: "issuer" })); await login(b);
    expect((await b.whoami()).json.userId).toBe(`${ISSUER}#idp-user-1`);
  });

  it("OIDC_CLIENT_AUTH=post sends the secret in the body", async () => {
    const e = mkEnv({ OIDC_CLIENT_AUTH: "post" });
    const b = new Browser(e);
    const start = await b.fetch("/auth/login");
    const cb = await idp.authorize(start.headers.get("Location")!);
    await b.fetch(cb.pathname + cb.search);
    expect(idp.tokenRequests[0]!.body.get("client_secret")).toBe(CLIENT_SECRET);
    expect(idp.tokenRequests[0]!.auth).toBeNull();
  });
});
