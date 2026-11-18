#!/usr/bin/env node
// Local mock OpenID provider for ituob #102 (member sign-in). DEV AND TESTS ONLY:
// no real identity service, no secrets, no network. It speaks just enough OIDC
// (discovery, JWKS, authorization code + PKCE, token) for worker/lib/oidc.ts.
//
//   node scripts/mock-idp.mjs serve [port]   # default 127.0.0.1:8788
//   node scripts/mock-idp.mjs sql            # SQL that gives the personas their D1 rows
//
// docs/identity-mock-provider.adoc explains the wrangler dev wiring and how a
// real provider replaces this by changing OIDC_* configuration only.
import { pathToFileURL } from "node:url";

export const MOCK_ISSUER = "http://127.0.0.1:8788";
export const MOCK_CLIENT_ID = "ituob-local-dev";
export const MOCK_CLIENT_SECRET = "local-dev-secret-not-real";

/**
 * Personas: the IdP side is only { sub, email, name }. What a signed-in persona
 * may DO comes from D1 (see personaSql), exactly as with a real provider.
 */
export const PERSONAS = {
  "itu-admin": { sub: "mock-itu-admin", email: "itu-admin@mock.test", name: "ITU Admin" },
  "itu-editor": { sub: "mock-itu-editor", email: "itu-editor@mock.test", name: "ITU Editor" },
  "member-aland": { sub: "mock-member-aland", email: "delegate@aland.mock.test", name: "Aland Delegate" },
  "member-suspendia": { sub: "mock-member-suspendia", email: "delegate@suspendia.mock.test", name: "Suspendia Delegate" },
  "pending-claimant": { sub: "mock-pending", email: "pending@mock.test", name: "Pending Claimant" },
  unaffiliated: { sub: "mock-unaffiliated", email: "nobody@mock.test", name: "Unaffiliated User" },
};

const q = (s) => `'${String(s).replaceAll("'", "''")}'`;
const T = "2026-01-01T00:00:00.000Z";

/** Idempotent SQL: personas' users, two mock member states, memberships and roles. */
export function personaSql() {
  const out = [];
  for (const p of Object.values(PERSONAS)) {
    out.push(`INSERT OR IGNORE INTO users (id,email,display_name,created_at) VALUES (${q(p.sub)},${q(p.email)},${q(p.name)},${q(T)});`);
  }
  out.push(
    `INSERT OR IGNORE INTO members (id,name,register_key,status,created_at,updated_at) VALUES ('MOCK-A','Aland (Mock Republic)','Aland','active',${q(T)},${q(T)});`,
    `INSERT OR IGNORE INTO members (id,name,register_key,status,created_at,updated_at) VALUES ('MOCK-S','Suspendia (Mock Republic)','Suspendia','suspended',${q(T)},${q(T)});`,
  );
  const membership = (user, kind, memberId, status) =>
    `INSERT INTO memberships (user_id,kind,member_id,status,claimed_at,created_at) SELECT ${q(user)},${q(kind)},${memberId ? q(memberId) : "NULL"},${q(status)},${q(T)},${q(T)} WHERE NOT EXISTS (SELECT 1 FROM memberships WHERE user_id=${q(user)} AND status IN ('pending','active'));`;
  const role = (user, r) => `INSERT OR IGNORE INTO user_roles (user_id,role,granted_at) VALUES (${q(user)},${q(r)},${q(T)});`;
  out.push(
    membership(PERSONAS["itu-admin"].sub, "itu", null, "active"), role(PERSONAS["itu-admin"].sub, "itu-admin"),
    membership(PERSONAS["itu-editor"].sub, "itu", null, "active"), role(PERSONAS["itu-editor"].sub, "itu-editor"),
    membership(PERSONAS["member-aland"].sub, "member", "MOCK-A", "active"), role(PERSONAS["member-aland"].sub, "member-submitter"),
    membership(PERSONAS["member-suspendia"].sub, "member", "MOCK-S", "active"), role(PERSONAS["member-suspendia"].sub, "member-submitter"),
    membership(PERSONAS["pending-claimant"].sub, "member", "MOCK-A", "pending"),
  );
  return out.join("\n") + "\n";
}

const b64url = (bytes) => {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const sha256b64url = async (s) => b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const loopback = (u) => ["127.0.0.1", "localhost", "[::1]"].includes(new URL(u).hostname);

function signInPage(url, personas, email = "", error = "") {
  const action = new URL(url);
  action.searchParams.delete("persona");
  const items = Object.entries(personas).map(([key, persona]) => {
    const choice = new URL(action);
    choice.searchParams.set("persona", key);
    return `<li><a href="${esc(choice.pathname + choice.search)}"><strong>${esc(persona.name)}</strong><span>${esc(persona.email)}</span></a></li>`;
  }).join("");
  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in — ITU Operational Bulletin</title>
<style>
/* Standalone loopback page: fonts and palette mirror src/styles/global.css. */
:root { color-scheme: light; --font-sans: Helvetica, Arial, sans-serif; --bg: #ffffff; --bg-2: #fafafa; --fg: #000000; --fg-2: #333333; --fg-3: #666666; --border: rgba(0,0,0,.12); --accent: #1aa1da; --link: #178ec4; }
* { box-sizing: border-box; } body { margin: 0; color: var(--fg); background: var(--bg-2); font: 1rem/1.5 var(--font-sans); }
header { background: var(--accent); color: white; padding: 1rem 5vw; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; }
main { width: min(100% - 2rem, 30rem); margin: 3rem auto; padding: 2rem; background: var(--bg); border: 1px solid var(--border); border-radius: .5rem; }
h1 { margin: 0; font-size: 2rem; line-height: 1.15; letter-spacing: -.022em; } p { color: var(--fg-2); } .notice { color: var(--fg-3); font-size: .875rem; }
label { display: block; font-weight: 600; margin-bottom: .5rem; } input, button { width: 100%; font: inherit; border-radius: .25rem; padding: .75rem; }
input { border: 1px solid var(--border); color: var(--fg); background: var(--bg); } button { margin-top: 1rem; border: 0; background: var(--link); color: white; font-weight: 600; cursor: pointer; }
button:hover { background: #137aa8; } :focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
details { margin-top: 2rem; border-top: 1px solid var(--border); padding-top: 1rem; } summary { cursor: pointer; font-weight: 600; }
ul { list-style: none; padding: 0; margin-bottom: 0; } li + li { border-top: 1px solid var(--border); } a { display: block; padding: .75rem 0; color: var(--link); text-decoration: none; } a:hover { text-decoration: underline; } a span { display: block; color: var(--fg-3); overflow-wrap: anywhere; font-size: .875rem; }
.error { color: #b42318; } @media (max-width: 400px) { main { padding: 1.25rem; margin: 1.5rem auto; } }
</style></head><body><header>ITU Operational Bulletin</header><main>
<h1>Sign in</h1><p>Continue with your email address.</p>
<p class="notice" id="local-notice">Local development only. This mock identity provider signs in test accounts without a password. Use a test email below.</p>
<form method="post" action="${esc(action.pathname + action.search)}">
<label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="email" required value="${esc(email)}" aria-describedby="local-notice${error ? " sign-in-error" : ""}"${error ? ' aria-invalid="true"' : ""}>
${error ? `<p class="error" id="sign-in-error" role="alert">${esc(error)}</p>` : ""}
<button type="submit">Continue</button></form>
<details><summary>Test accounts</summary><p class="notice">Choose a local test account to sign in directly.</p><ul>${items}</ul></details>
</main></body></html>`, { status: error ? 400 : 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

/**
 * Returns { handle(Request) -> Promise<Response>, issuer }. Pure fetch-handler:
 * runs under Node (serve) and inside the Worker test pool (outbound-fetch shim).
 * Redirect URIs must be loopback: the mock never redirects a browser off-box.
 */
export async function createMockIdp({
  issuer = MOCK_ISSUER, clientId = MOCK_CLIENT_ID, clientSecret = MOCK_CLIENT_SECRET,
  clientAuth = "basic", personas = PERSONAS, ttlSeconds = 300,
} = {}) {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "mock-1", use: "sig", alg: "ES256" };
  const codes = new Map();
  const base = issuer.replace(/\/+$/, "");

  const sign = async (payload) => {
    const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
    const input = `${enc({ alg: "ES256", kid: "mock-1", typ: "JWT" })}.${enc(payload)}`;
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(input));
    return `${input}.${b64url(sig)}`;
  };
  const err = (status, error) => Response.json({ error }, { status });

  async function authorize(url, submittedEmail) {
    const p = url.searchParams;
    const redirect = p.get("redirect_uri");
    if (p.get("client_id") !== clientId || !redirect || !URL.canParse(redirect) || !loopback(redirect)) {
      return new Response("bad client_id or redirect_uri", { status: 400 });
    }
    if (p.get("response_type") !== "code" || p.get("code_challenge_method") !== "S256" || !p.get("code_challenge") || !p.get("state") || !p.get("nonce")) {
      return new Response("response_type=code, S256 PKCE, state and nonce are required", { status: 400 });
    }
    if (submittedEmail !== undefined) {
      const email = submittedEmail.trim();
      const match = Object.entries(personas).find(([, persona]) => persona.email.toLowerCase() === email.toLowerCase());
      if (!match) return signInPage(url, personas, email, "Enter an email address from the test accounts below.");
      p.set("persona", match[0]);
    }
    const who = p.get("persona");
    if (!who) return signInPage(url, personas);
    const persona = personas[who];
    if (!persona) return new Response("unknown persona", { status: 400 });
    const code = b64url(crypto.getRandomValues(new Uint8Array(16)));
    codes.set(code, { nonce: p.get("nonce"), challenge: p.get("code_challenge"), redirect, persona, at: Date.now() });
    const cb = new URL(redirect);
    cb.searchParams.set("code", code);
    cb.searchParams.set("state", p.get("state"));
    return new Response(null, { status: 302, headers: { Location: cb.toString() } });
  }

  async function token(req) {
    const form = new URLSearchParams(new TextDecoder().decode(await req.arrayBuffer()));
    let id = form.get("client_id"), secret = form.get("client_secret");
    const auth = req.headers.get("Authorization");
    if (auth?.startsWith("Basic ")) {
      try {
        const decoded = atob(auth.slice(6));
        const colon = decoded.indexOf(":");
        if (colon < 0) return err(401, "invalid_client");
        id = decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, "%20"));
        secret = decodeURIComponent(decoded.slice(colon + 1).replace(/\+/g, "%20"));
      } catch {
        return err(401, "invalid_client");
      }
    }
    if (id !== clientId || (clientAuth !== "none" && secret !== clientSecret)) return err(401, "invalid_client");
    const rec = codes.get(form.get("code") ?? "");
    codes.delete(form.get("code") ?? ""); // single use
    const verifier = form.get("code_verifier");
    if (!rec || !verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || form.get("grant_type") !== "authorization_code" || form.get("redirect_uri") !== rec.redirect
      || Date.now() - rec.at > 60_000 || (await sha256b64url(verifier)) !== rec.challenge) {
      return err(400, "invalid_grant");
    }
    const now = Math.floor(Date.now() / 1000);
    const { sub, email, name } = rec.persona;
    const id_token = await sign({ iss: base, aud: clientId, iat: now, exp: now + ttlSeconds, nonce: rec.nonce, sub, email, email_verified: true, name });
    return Response.json({ access_token: "opaque", token_type: "Bearer", id_token }, { headers: { "Cache-Control": "no-store" } });
  }

  return {
    issuer: base,
    async handle(req) {
      const url = new URL(req.url);
      if (url.pathname === "/.well-known/openid-configuration") {
        return Response.json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, jwks_uri: `${base}/jwks`, id_token_signing_alg_values_supported: ["ES256"] });
      }
      if (url.pathname === "/jwks") return Response.json({ keys: [jwk] });
      if (url.pathname === "/authorize" && req.method === "GET") return authorize(url);
      if (url.pathname === "/authorize" && req.method === "POST") {
        const form = new URLSearchParams(new TextDecoder().decode(await req.arrayBuffer()));
        return authorize(url, form.get("email") ?? "");
      }
      if (url.pathname === "/token" && req.method === "POST") return token(req);
      return new Response("not found", { status: 404 });
    },
  };
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "sql") return process.stdout.write(personaSql());
  if (cmd !== "serve") { console.error("usage: mock-idp.mjs serve [port] | sql"); process.exit(2); }
  const port = Number(arg ?? new URL(MOCK_ISSUER).port);
  const idp = await createMockIdp({ issuer: `http://127.0.0.1:${port}` });
  const { createServer } = await import("node:http");
  createServer(async (nreq, nres) => {
    try {
      const chunks = [];
      for await (const c of nreq) chunks.push(c);
      const body = nreq.method === "GET" || nreq.method === "HEAD" ? undefined : Buffer.concat(chunks);
      const res = await idp.handle(new Request(`http://127.0.0.1:${port}${nreq.url}`, { method: nreq.method, headers: nreq.headers, body }));
      nres.writeHead(res.status, Object.fromEntries(res.headers));
      nres.end(Buffer.from(await res.arrayBuffer()));
    } catch (error) {
      console.error("mock identity provider request failed", error);
      if (!nres.headersSent) nres.writeHead(500, { "Content-Type": "application/json" });
      nres.end(JSON.stringify({ error: "server_error" }));
    }
  }).listen(port, "127.0.0.1", () => console.log(`mock identity provider on http://127.0.0.1:${port} (dev only)`));
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
