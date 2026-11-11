import { sameOrigin } from "./csrf.ts";
import {
  OidcError,
  authorizationUrl,
  exchangeCode,
  oidcConfig,
  randomToken,
  verifyIdToken,
  type IdClaims,
  type OidcConfig,
} from "./oidc.ts";
import { clearedSessionCookie, createSession, destroySession, readCookie, sessionCookie, SESSION_COOKIE } from "./session.ts";
import type { Env } from "./types.ts";

const FLOW_COOKIE = "__Host-ituob_flow";
const FLOW_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_FLOWS = 5000;
// __Host- forces Path=/ (the design note's "Path=/auth" is not a valid __Host- cookie).
const flowCookie = (id: string) => `${FLOW_COOKIE}=${id}; Max-Age=${FLOW_TTL_MS / 1000}; Path=/; Secure; HttpOnly; SameSite=Lax`;
const clearedFlowCookie = () => `${FLOW_COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`;

const NO_STORE = { "Cache-Control": "no-store" };

function page(status: number, message: string, cookies: string[] = []): Response {
  const h = new Headers({ ...NO_STORE, "Content-Type": "text/html; charset=utf-8" });
  for (const c of cookies) h.append("Set-Cookie", c);
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Sign-in</title><p>${message}</p><p><a href="/">Back to ituob.org</a></p>`,
    { status, headers: h },
  );
}

function redirect(location: string, cookies: string[], status = 302): Response {
  const h = new Headers({ ...NO_STORE, Location: location });
  for (const c of cookies) h.append("Set-Cookie", c);
  return new Response(null, { status, headers: h });
}

/** return_to is a path, never a URL. */
export function safeReturnTo(v: string | null): string {
  if (!v || v.length > 512) return "/";
  if (!/^\/(?![/\\])[^\u0000-\u001f\u007f\\]*$/.test(v)) return "/";
  return v;
}

export async function handleAuth(request: Request, env: Env, url: URL): Promise<Response> {
  if (env.AUTH_MODE === "stub") return Response.json({ error: "login is not available in stub mode" }, { status: 501, headers: NO_STORE });
  const cfg = env.AUTH_MODE === "oidc" ? oidcConfig(env) : null;
  if (!cfg) return page(503, "Sign-in is not available.");

  const method = request.method.toUpperCase();
  const path = url.pathname;
  try {
    if (path === "/auth/login") return method === "GET" ? await login(cfg, request, env, url) : page(405, "Method not allowed.");
    if (path === "/auth/callback") return method === "GET" ? await callback(cfg, request, env, url) : page(405, "Method not allowed.");
    if (path === "/auth/logout") return method === "POST" ? await logout(cfg, request, env) : page(405, "Method not allowed.");
    return page(404, "Not found.");
  } catch (e) {
    if (e instanceof OidcError) {
      return e.kind === "upstream"
        ? page(502, "The identity service is not reachable. Please try again later.", [clearedFlowCookie()])
        : page(400, "Sign-in failed. Please start again.", [clearedFlowCookie()]);
    }
    throw e;
  }
}

async function login(cfg: OidcConfig, request: Request, env: Env, url: URL): Promise<Response> {
  const now = Date.now();
  await env.DB.prepare(`DELETE FROM oidc_flows WHERE created_at < ?1`).bind(new Date(now - FLOW_TTL_MS).toISOString()).run();
  const pending = await env.DB.prepare(`SELECT count(*) AS n FROM oidc_flows`).first<{ n: number }>();
  if ((pending?.n ?? 0) >= MAX_PENDING_FLOWS) return page(503, "Sign-in is busy. Please try again shortly.");

  const flow = { id: randomToken(16), state: randomToken(24), nonce: randomToken(24), verifier: randomToken(48), returnTo: safeReturnTo(url.searchParams.get("return_to")) };
  const location = await authorizationUrl(cfg, request, { state: flow.state, nonce: flow.nonce, codeVerifier: flow.verifier });
  await env.DB
    .prepare(`INSERT INTO oidc_flows (id, state, nonce, code_verifier, return_to, created_at) VALUES (?1,?2,?3,?4,?5,?6)`)
    .bind(flow.id, flow.state, flow.nonce, flow.verifier, flow.returnTo, new Date(now).toISOString())
    .run();
  return redirect(location, [flowCookie(flow.id)]);
}

async function callback(cfg: OidcConfig, request: Request, env: Env, url: URL): Promise<Response> {
  const clear = [clearedFlowCookie()];
  const flowId = readCookie(request, FLOW_COOKIE);
  if (!flowId || flowId.length > 64) return page(400, "Sign-in failed. Please start again.", clear);

  // Single use: the flow is consumed by the first callback attempt, success or failure.
  const flow = await env.DB
    .prepare(`DELETE FROM oidc_flows WHERE id = ?1 RETURNING state, nonce, code_verifier, return_to, created_at`)
    .bind(flowId)
    .first<{ state: string; nonce: string; code_verifier: string; return_to: string; created_at: string }>();
  if (!flow || Date.now() - Date.parse(flow.created_at) > FLOW_TTL_MS) return page(400, "Sign-in expired. Please start again.", clear);

  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!state || state !== flow.state) return page(400, "Sign-in failed. Please start again.", clear);
  if (url.searchParams.has("error") || !code) return page(400, "Sign-in was not completed.", clear);

  const idToken = await exchangeCode(cfg, request, code, flow.code_verifier);
  const claims = await verifyIdToken(cfg, idToken, flow.nonce);
  await upsertUser(env.DB, claims);

  // Fixation: a pre-existing session is discarded; the new one is always minted.
  const old = readCookie(request, SESSION_COOKIE);
  if (old) await destroySession(env.DB, old);
  const token = await createSession(env.DB, claims.sub);
  return redirect(safeReturnTo(flow.return_to), [sessionCookie(token), ...clear]);
}

/** sub is the only key; email/name are a cache of the identity service. Never merge by email. */
async function upsertUser(db: D1Database, c: IdClaims): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO users (id, email, display_name, created_at, last_login_at) VALUES (?1,?2,?3,?4,?4)
       ON CONFLICT(id) DO UPDATE SET
         email = COALESCE(excluded.email, users.email),
         display_name = COALESCE(excluded.display_name, users.display_name),
         last_login_at = excluded.last_login_at`,
    )
    .bind(c.sub, c.email, c.displayName, now)
    .run();
}

async function logout(cfg: OidcConfig, request: Request, env: Env): Promise<Response> {
  if (!sameOrigin(request)) return page(403, "Forbidden.");
  const token = readCookie(request, SESSION_COOKIE);
  if (token) await destroySession(env.DB, token);
  let location = "/";
  // RP-initiated logout only when the config names an end_session_endpoint (A6).
  if (cfg.endSessionEndpoint) {
    const u = new URL(cfg.endSessionEndpoint);
    u.searchParams.set("client_id", cfg.clientId);
    u.searchParams.set("post_logout_redirect_uri", cfg.postLogoutRedirectUri ?? `${new URL(request.url).origin}/`);
    location = u.toString();
  }
  return redirect(location, [clearedSessionCookie()], 303);
}
