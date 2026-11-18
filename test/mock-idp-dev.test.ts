import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import worker from "../worker/index.ts";
import { resetOidcCaches } from "../worker/lib/oidc.ts";
import { ABSOLUTE_MS } from "../worker/lib/session.ts";
import { MOCK_CLIENT_ID, MOCK_CLIENT_SECRET, MOCK_ISSUER, PERSONAS, createMockIdp, personaSql } from "../scripts/mock-idp.mjs";
import { db } from "./helpers.ts";

// The shipped local mock provider (scripts/mock-idp.mjs), driven through the
// real Worker over the real OIDC code path. Only the network hop is shimmed.
const ENV = { ...env, AUTH_MODE: "oidc", OIDC_ISSUER: MOCK_ISSUER, OIDC_CLIENT_ID: MOCK_CLIENT_ID, OIDC_CLIENT_SECRET: MOCK_CLIENT_SECRET } as any;
const SESSION = "__Host-ituob_session";

let idp: Awaited<ReturnType<typeof createMockIdp>>;
let spy: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  idp = await createMockIdp();
  resetOidcCaches();
  const real = globalThis.fetch;
  spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
    const req = new Request(input, init);
    return new URL(req.url).origin === MOCK_ISSUER ? idp.handle(req) : real(input, init);
  });
  await db().exec(personaSql().replaceAll("\n", " ").replace(/;\s+/g, ";\n"));
});
afterEach(() => spy.mockRestore());

class Browser {
  jar = new Map<string, string>();
  constructor(readonly origin = "https://127.0.0.1:8443") {}
  async fetch(path: string, init: RequestInit & { json?: unknown } = {}) {
    const url = new URL(path, this.origin);
    const headers = new Headers(init.headers);
    if (this.jar.size) headers.set("Cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const method = init.method ?? "GET";
    if (method !== "GET") headers.set("Sec-Fetch-Site", "same-origin");
    if (init.json !== undefined) headers.set("Content-Type", "application/json");
    const res = await worker.fetch(new Request(url.toString(), { method, headers, body: init.json === undefined ? undefined : JSON.stringify(init.json), redirect: "manual" }), ENV);
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(";");
      // Enforce the cookie contract instead of accepting Secure cookies over HTTP.
      if (url.protocol !== "https:" && attrs.some((a) => a.trim().toLowerCase() === "secure")) continue;
      const i = pair!.indexOf("=");
      const v = pair!.slice(i + 1);
      if (v === "" || attrs.some((a) => a.trim().toLowerCase() === "max-age=0")) this.jar.delete(pair!.slice(0, i));
      else this.jar.set(pair!.slice(0, i), v);
    }
    return res;
  }
  /** /auth/login -> mock sign-in form / account chooser -> /auth/callback. */
  async signIn(persona: string, email?: string) {
    const start = await this.fetch("/auth/login");
    expect(start.status).toBe(302);
    const loc = start.headers.get("Location")!;
    const picker = await idp.handle(new Request(loc));
    expect(picker.status).toBe(200);
    expect(await picker.text()).toContain(`persona=${persona}`);
    const chosen = await idp.handle(email === undefined
      ? new Request(`${loc}&persona=${persona}`)
      : new Request(loc, { method: "POST", body: new URLSearchParams({ email }) }));
    expect(chosen.status).toBe(302);
    const cb = new URL(chosen.headers.get("Location")!);
    return this.fetch(cb.pathname + cb.search);
  }
  async whoami() { return (await (await this.fetch("/api/whoami")).json()) as any; }
}

const submission = (key: string) => ({ register_id: "E118_IIN", slug: "e118-iin", action_type: "ADD", payload: { type: "ADD", data: { _class: "E118Amendment", entries: [{ country_or_area: { en: key }, company_name: "Acme Telecom", issue_id_number: "89 358 01" }] } } });
const propose = (b: Browser, key: string) => b.fetch("/api/me/submissions", { method: "POST", json: submission(key) });

describe("sign-in and sign-out against the local mock provider", () => {
  it("cannot complete the old HTTP flow because the browser rejects its Secure flow cookie", async () => {
    const b = new Browser("http://127.0.0.1:8787");
    expect((await b.signIn("member-aland")).status).toBe(400);
    expect(b.jar.size).toBe(0);
    expect((await b.whoami()).authenticated).toBe(false);
  });

  it("signs in through the email form with the existing account's identity and permissions", async () => {
    const b = new Browser();
    const cb = await b.signIn("member-aland", " DELEGATE@ALAND.MOCK.TEST ");
    expect(cb.status).toBe(302);
    expect(b.jar.has(SESSION)).toBe(true);
    expect(await b.whoami()).toMatchObject({ authenticated: true, userId: PERSONAS["member-aland"].sub, roles: ["member-submitter"], memberStateId: "MOCK-A" });
    expect((await propose(b, "Aland")).status).toBe(201);
    expect((await propose(b, "Suspendia")).status).toBe(403);
  });

  it("signs a persona in, keeps the session, and signs out", async () => {
    const b = new Browser();
    expect((await b.whoami()).authenticated).toBe(false);
    const cb = await b.signIn("member-aland");
    expect(cb.status).toBe(302);
    expect(b.jar.has(SESSION)).toBe(true);
    expect(await b.whoami()).toMatchObject({ authenticated: true, userId: PERSONAS["member-aland"].sub, user: { email: PERSONAS["member-aland"].email } });
    const out = await b.fetch("/auth/logout", { method: "POST" });
    expect(out.status).toBe(303);
    expect(b.jar.has(SESSION)).toBe(false);
    expect((await b.whoami()).authenticated).toBe(false);
    expect((await db().prepare("SELECT count(*) n FROM sessions").first<any>()).n).toBe(0);
  });

  it("a signed-out cookie replayed by an attacker no longer authenticates", async () => {
    const b = new Browser();
    await b.signIn("member-aland");
    const stolen = b.jar.get(SESSION)!;
    await b.fetch("/auth/logout", { method: "POST" });
    const replay = new Browser(); replay.jar.set(SESSION, stolen);
    expect((await replay.whoami()).authenticated).toBe(false);
  });
});

describe("forged, expired and orphaned sessions", () => {
  it("a made-up or altered cookie is anonymous", async () => {
    const b = new Browser();
    await b.signIn("itu-editor");
    for (const forged of ["not-a-real-token", `${b.jar.get(SESSION)!}x`, "A".repeat(43), "A".repeat(200), "' OR 1=1 --"]) {
      const f = new Browser(); f.jar.set(SESSION, forged);
      expect((await f.whoami()).authenticated).toBe(false);
      expect((await propose(f, "Aland")).status).toBe(401);
    }
    expect((await b.whoami()).authenticated).toBe(true); // the genuine one is unaffected
  });

  it("an expired session is refused and its row removed", async () => {
    const b = new Browser();
    await b.signIn("member-aland");
    await db().prepare("UPDATE sessions SET expires_at = ?1").bind(new Date(Date.now() - 1000).toISOString()).run();
    expect((await b.whoami()).authenticated).toBe(false);
    expect((await db().prepare("SELECT count(*) n FROM sessions").first<any>()).n).toBe(0);
    expect(ABSOLUTE_MS).toBe(7 * 24 * 3600 * 1000);
  });

  it("a user with a live session cannot be deleted out from under it (schema FK), so no orphan session exists", async () => {
    const b = new Browser();
    await b.signIn("unaffiliated");
    await expect(db().prepare("DELETE FROM users WHERE id = ?1").bind(PERSONAS.unaffiliated.sub).run()).rejects.toThrow(/FOREIGN KEY/);
    expect((await b.whoami()).authenticated).toBe(true);
  });
});

describe("who a signed-in persona is, and what that allows", () => {
  it("a first-time unknown sign-in creates an inert account that cannot submit", async () => {
    const b = new Browser();
    await b.signIn("unaffiliated");
    expect(await b.whoami()).toMatchObject({ authenticated: true, roles: [], memberStateId: null });
    expect((await propose(b, "Aland")).status).toBe(403);
  });

  it("a sub the database has never seen gets a new inert account on first sign-in", async () => {
    idp = await createMockIdp({ personas: { stranger: { sub: "mock-stranger", email: "s@mock.test", name: "Stranger" } } });
    const b = new Browser();
    expect(await db().prepare("SELECT id FROM users WHERE id='mock-stranger'").first()).toBeNull();
    await b.signIn("stranger");
    expect(await b.whoami()).toMatchObject({ authenticated: true, userId: "mock-stranger", roles: [], memberStateId: null });
    expect((await propose(b, "Aland")).status).toBe(403);
  });

  it("a pending claimant is inert until verified", async () => {
    const b = new Browser();
    await b.signIn("pending-claimant");
    expect(await b.whoami()).toMatchObject({ roles: [], memberStateId: null });
    expect((await propose(b, "Aland")).status).toBe(403);
  });

  it("a member of a suspended state is signed in but denied", async () => {
    const b = new Browser();
    await b.signIn("member-suspendia");
    expect(await b.whoami()).toMatchObject({ authenticated: true, roles: [], memberStateId: null });
    expect((await propose(b, "Suspendia")).status).toBe(403);
  });

  it("an active member maps to member-submitter bound to their own state only", async () => {
    const b = new Browser();
    await b.signIn("member-aland");
    expect(await b.whoami()).toMatchObject({ roles: ["member-submitter"], memberStateId: "MOCK-A" });
    expect((await propose(b, "Aland")).status).toBe(201);
    expect((await propose(b, "Suspendia")).status).toBe(403);
  });

  it("ITU editor and admin personas map to their own roles; neither is a member", async () => {
    const ed = new Browser(); await ed.signIn("itu-editor");
    expect(await ed.whoami()).toMatchObject({ roles: ["itu-editor"], memberStateId: null });
    expect((await propose(ed, "Suspendia")).status).toBe(201); // ITU may submit for any key
    const ad = new Browser(); await ad.signIn("itu-admin");
    expect(await ad.whoami()).toMatchObject({ roles: ["itu-admin"], memberStateId: null });
  });

  it("a signed-in session never satisfies the Access-guarded admin API", async () => {
    const ad = new Browser(); await ad.signIn("itu-admin");
    expect((await ad.fetch("/api/admin/claims")).status).toBe(403);
  });

  it("suspending the state removes the member's authority on the next request", async () => {
    const b = new Browser(); await b.signIn("member-aland");
    await db().prepare("UPDATE members SET status='suspended', updated_at=?1 WHERE id='MOCK-A'").bind(new Date().toISOString()).run();
    expect((await propose(b, "Aland")).status).toBe(403);
  });
});

describe("the mock provider itself", () => {
  const authorizeUrl = async (over: Record<string, string> = {}) => {
    const start = await new Browser().fetch("/auth/login");
    const u = new URL(start.headers.get("Location")!);
    for (const [k, v] of Object.entries(over)) u.searchParams.set(k, v);
    return u;
  };

  it("renders an accessible email form with the OIDC request and a labelled test account chooser", async () => {
    const url = await authorizeUrl();
    const response = await idp.handle(new Request(url));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const html = await response.text();
    expect(html).toContain('<label for="email">Email address</label>');
    expect(html).toContain('name="email" type="email" autocomplete="email" required');
    expect(html).toContain('<button type="submit">Continue</button>');
    expect(html).toContain('<summary>Test accounts</summary>');
    expect(html).toContain("Local development only");
    const action = html.match(/<form method="post" action="([^"]+)"/)![1]!.replaceAll("&amp;", "&");
    expect(new URL(action, url).searchParams.toString()).toBe(url.searchParams.toString());
    for (const [key, persona] of Object.entries(PERSONAS)) {
      expect(html).toContain(`persona=${key}`);
      expect(html).toContain(persona.email);
    }
  });

  it.each(["", "unknown@mock.test", '\"><script>alert(1)</script>'])("rejects an unknown email (%s) without redirecting or losing the form", async (email) => {
    const response = await idp.handle(new Request(await authorizeUrl(), { method: "POST", body: new URLSearchParams({ email }) }));
    expect(response.status).toBe(400);
    expect(response.headers.has("Location")).toBe(false);
    const html = await response.text();
    expect(html).toContain('role="alert"');
    expect(html).toContain("Enter an email address from the test accounts below.");
    expect(html).not.toContain("<script>");
    expect(html).toContain('<button type="submit">Continue</button>');
  });

  it("still validates loopback redirects and PKCE before accepting an email submission", async () => {
    for (const over of [{ redirect_uri: "https://evil.example/cb" }, { code_challenge: "" }, { client_id: "other" }]) {
      const response = await idp.handle(new Request(await authorizeUrl(over), { method: "POST", body: new URLSearchParams({ email: PERSONAS["itu-admin"].email }) }));
      expect(response.status).toBe(400);
      expect(response.headers.has("Location")).toBe(false);
    }
  });

  it("refuses a redirect_uri off loopback, a wrong client and missing PKCE", async () => {
    for (const over of [{ redirect_uri: "https://evil.example/cb" }, { client_id: "other" }, { code_challenge: "" }, { code_challenge_method: "plain" }, { code_challenge_method: "" }]) {
      expect((await idp.handle(new Request(await authorizeUrl({ ...over, persona: "member-aland" })))).status).toBe(400);
    }
  });

  const verifier = "v".repeat(43);
  const challenge = async (value: string) => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return btoa(String.fromCharCode(...new Uint8Array(digest))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  };
  const issueCode = async (value = verifier) => {
    const u = await authorizeUrl({ persona: "member-aland", code_challenge: await challenge(value) });
    const response = await idp.handle(new Request(u));
    expect(response.status).toBe(302);
    return { code: new URL(response.headers.get("Location")!).searchParams.get("code")!, redirect: u.searchParams.get("redirect_uri")! };
  };
  const redeem = (issued: { code: string; redirect: string }, value: string | undefined = verifier, auth = `Basic ${btoa(`${MOCK_CLIENT_ID}:${MOCK_CLIENT_SECRET}`)}`) => {
    const form = new URLSearchParams({ grant_type: "authorization_code", code: issued.code, redirect_uri: issued.redirect });
    if (value !== undefined) form.set("code_verifier", value);
    return idp.handle(new Request(`${MOCK_ISSUER}/token`, { method: "POST", headers: { Authorization: auth }, body: form }));
  };

  it.each(["Basic !!!", `Basic ${btoa("%ZZ:x")}`])("rejects malformed client authentication (%s) and remains available", async (auth) => {
    const issued = await issueCode();
    const bad = await redeem(issued, verifier, auth);
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ error: "invalid_client" });
    expect((await redeem(issued)).status).toBe(200);
  });

  it.each([undefined, "", "short", "!".repeat(43), "v".repeat(129)])("requires a syntactically valid PKCE verifier (%s)", async (value) => {
    // Match the challenge even for invalid verifier values: hashing alone must not accept them.
    const issued = await issueCode(value ?? "");
    const form = new URLSearchParams({ grant_type: "authorization_code", code: issued.code, redirect_uri: issued.redirect });
    if (value !== undefined) form.set("code_verifier", value);
    const res = await idp.handle(new Request(`${MOCK_ISSUER}/token`, { method: "POST", headers: { Authorization: `Basic ${btoa(`${MOCK_CLIENT_ID}:${MOCK_CLIENT_SECRET}`)}` }, body: form }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_grant" });
  });

  it("accepts a correct verifier once and rejects the identical code replay", async () => {
    const issued = await issueCode();
    const first = await redeem(issued);
    expect(first.status).toBe(200);
    expect(await first.json()).toHaveProperty("id_token");
    const replay = await redeem(issued);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: "invalid_grant" });
  });

  it("consumes a code even when the first verifier is wrong", async () => {
    const issued = await issueCode();
    expect((await redeem(issued, "w".repeat(43))).status).toBe(400);
    expect((await redeem(issued)).status).toBe(400);
  });

  it("persona SQL is idempotent and creates exactly one live membership per persona", async () => {
    await db().exec(personaSql().replaceAll("\n", " ").replace(/;\s+/g, ";\n"));
    const rows = await db().prepare("SELECT user_id, count(*) n FROM memberships WHERE status IN ('pending','active') GROUP BY user_id").all<any>();
    expect(rows.results.every((r: any) => r.n === 1)).toBe(true);
    expect(rows.results).toHaveLength(5);
  });
});
