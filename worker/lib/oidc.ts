import { isLoopbackHost } from "./host.ts";
import type { Env } from "./types.ts";

/**
 * Generic OpenID Connect relying party (authorization code + PKCE) for #102.
 * Every assumption about ribosei/identity (docs/identity-accounts.adoc, A1-A11)
 * is a config knob below; nothing defaults to a real host.
 */

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string | null;
  /** A5: "basic" (client_secret_basic), "post" (client_secret_post) or "none" (public client, PKCE only). */
  clientAuth: "basic" | "post" | "none";
  /** A2: explicit endpoints skip discovery for that endpoint. */
  authorizationEndpoint: string | null;
  tokenEndpoint: string | null;
  jwksUri: string | null;
  /** A6: RP-initiated logout only when configured. Never taken from discovery. */
  endSessionEndpoint: string | null;
  postLogoutRedirectUri: string | null;
  /** A3 */
  scopes: string;
  /** A4: "verbatim" => users.id = sub; "issuer" => users.id = `${issuer}#${sub}`. */
  subKey: "verbatim" | "issuer";
  /** A8 */
  algs: ("RS256" | "ES256")[];
  /** A5: override of `${origin}/auth/callback`. */
  redirectUri: string | null;
}

const opt = (v: string | undefined) => (v && v.trim() ? v.trim() : null);

/** Returns null when required config is missing or invalid: callers fail closed. */
export function oidcConfig(env: Env): OidcConfig | null {
  const issuer = opt(env.OIDC_ISSUER);
  const clientId = opt(env.OIDC_CLIENT_ID);
  if (!issuer || !clientId || !isHttpsOrLoopback(issuer)) return null;
  const clientAuthRaw = opt(env.OIDC_CLIENT_AUTH) ?? "basic";
  if (clientAuthRaw !== "basic" && clientAuthRaw !== "post" && clientAuthRaw !== "none") return null;
  const clientSecret = opt(env.OIDC_CLIENT_SECRET);
  if (clientAuthRaw !== "none" && !clientSecret) return null;
  const algs = (opt(env.OIDC_ID_TOKEN_ALGS) ?? "RS256,ES256").split(",").map((a) => a.trim());
  if (algs.length === 0 || !algs.every((a) => a === "RS256" || a === "ES256")) return null;
  const subKey = opt(env.OIDC_SUB_KEY) ?? "verbatim";
  if (subKey !== "verbatim" && subKey !== "issuer") return null;
  const endpoints = [env.OIDC_AUTHORIZATION_ENDPOINT, env.OIDC_TOKEN_ENDPOINT, env.OIDC_JWKS_URI, env.OIDC_END_SESSION_ENDPOINT, env.OIDC_REDIRECT_URI, env.OIDC_POST_LOGOUT_REDIRECT_URI].map(opt);
  if (endpoints.some((e) => e && !isHttpsOrLoopback(e))) return null;
  return {
    issuer,
    clientId,
    clientSecret: clientAuthRaw === "none" ? null : clientSecret,
    clientAuth: clientAuthRaw,
    authorizationEndpoint: endpoints[0]!,
    tokenEndpoint: endpoints[1]!,
    jwksUri: endpoints[2]!,
    endSessionEndpoint: endpoints[3]!,
    redirectUri: endpoints[4]!,
    postLogoutRedirectUri: endpoints[5]!,
    scopes: opt(env.OIDC_SCOPES) ?? "openid email profile",
    subKey: subKey as "verbatim" | "issuer",
    algs: algs as ("RS256" | "ES256")[],
  };
}

function isHttpsOrLoopback(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname));
  } catch {
    return false;
  }
}

export class OidcError extends Error {
  constructor(message: string, readonly kind: "invalid" | "upstream" = "invalid") {
    super(message);
  }
}

// ---- encoding helpers -------------------------------------------------------

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function unb64url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new OidcError("bad base64url");
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
export const randomToken = (bytes: number) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));
export async function sha256b64url(s: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

// ---- discovery and JWKS (isolate-level caches) ------------------------------

interface Discovery {
  issuer: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  jwks_uri?: string;
}
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_MIN_REFRESH_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

const discoveryCache = new Map<string, { at: number; doc: Discovery }>();
const jwksCache = new Map<string, { at: number; keys: JsonWebKey[] }>();

/** Test hook: drop isolate-level caches. */
export function resetOidcCaches(): void {
  discoveryCache.clear();
  jwksCache.clear();
}

async function getJson(url: string): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    throw new OidcError("identity service unreachable", "upstream");
  }
  if (!res.ok) throw new OidcError(`identity service returned ${res.status}`, "upstream");
  try {
    return await res.json();
  } catch {
    throw new OidcError("identity service returned invalid JSON", "upstream");
  }
}

async function discovery(cfg: OidcConfig): Promise<Discovery> {
  const hit = discoveryCache.get(cfg.issuer);
  if (hit && Date.now() - hit.at < DISCOVERY_TTL_MS) return hit.doc;
  const doc = await getJson(`${cfg.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`);
  if (!doc || typeof doc !== "object" || doc.issuer !== cfg.issuer) {
    throw new OidcError("discovery issuer mismatch", "upstream");
  }
  discoveryCache.set(cfg.issuer, { at: Date.now(), doc });
  return doc;
}

async function endpoint(cfg: OidcConfig, which: "authorization_endpoint" | "token_endpoint" | "jwks_uri"): Promise<string> {
  const override = { authorization_endpoint: cfg.authorizationEndpoint, token_endpoint: cfg.tokenEndpoint, jwks_uri: cfg.jwksUri }[which];
  if (override) return override;
  const v = (await discovery(cfg))[which];
  if (typeof v !== "string" || !isHttpsOrLoopback(v)) throw new OidcError(`discovery lacks a usable ${which}`, "upstream");
  return v;
}

async function jwksKeys(cfg: OidcConfig, forceRefresh: boolean): Promise<JsonWebKey[]> {
  const hit = jwksCache.get(cfg.issuer);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (hit && age < JWKS_TTL_MS && !(forceRefresh && age >= JWKS_MIN_REFRESH_MS)) return hit.keys;
  if (hit && forceRefresh && age < JWKS_MIN_REFRESH_MS) return hit.keys; // refresh is rate-limited
  const doc = await getJson(await endpoint(cfg, "jwks_uri"));
  const keys = Array.isArray(doc?.keys) ? (doc.keys as JsonWebKey[]) : [];
  jwksCache.set(cfg.issuer, { at: Date.now(), keys });
  return keys;
}

// ---- authorization request --------------------------------------------------

export function redirectUri(cfg: OidcConfig, request: Request): string {
  return cfg.redirectUri ?? `${new URL(request.url).origin}/auth/callback`;
}

export async function authorizationUrl(
  cfg: OidcConfig,
  request: Request,
  p: { state: string; nonce: string; codeVerifier: string },
): Promise<string> {
  const u = new URL(await endpoint(cfg, "authorization_endpoint"));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", redirectUri(cfg, request));
  u.searchParams.set("scope", cfg.scopes);
  u.searchParams.set("state", p.state);
  u.searchParams.set("nonce", p.nonce);
  u.searchParams.set("code_challenge", await sha256b64url(p.codeVerifier));
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

// ---- token exchange ---------------------------------------------------------

export async function exchangeCode(
  cfg: OidcConfig,
  request: Request,
  code: string,
  codeVerifier: string,
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(cfg, request),
    code_verifier: codeVerifier,
    client_id: cfg.clientId,
  });
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  if (cfg.clientAuth === "basic") {
    headers.Authorization = `Basic ${btoa(`${formEncode(cfg.clientId)}:${formEncode(cfg.clientSecret!)}`)}`;
  } else if (cfg.clientAuth === "post") {
    body.set("client_secret", cfg.clientSecret!);
  }
  let res: Response;
  try {
    res = await fetch(await endpoint(cfg, "token_endpoint"), { method: "POST", headers, body, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (e) {
    if (e instanceof OidcError) throw e;
    throw new OidcError("identity service unreachable", "upstream");
  }
  if (!res.ok) throw new OidcError(`token endpoint returned ${res.status}`, "upstream");
  let json: any;
  try {
    json = await res.json();
  } catch {
    throw new OidcError("token endpoint returned invalid JSON", "upstream");
  }
  if (typeof json?.id_token !== "string") throw new OidcError("token response has no id_token");
  return json.id_token;
}

const formEncode = (s: string) => encodeURIComponent(s).replace(/%20/g, "+");

// ---- ID token validation ----------------------------------------------------

export interface IdClaims {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
}
const SKEW_S = 60;

const ALG_PARAMS = {
  RS256: { import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, verify: { name: "RSASSA-PKCS1-v1_5" }, kty: "RSA" },
  ES256: { import: { name: "ECDSA", namedCurve: "P-256" }, verify: { name: "ECDSA", hash: "SHA-256" }, kty: "EC" },
} as const;

function decodePart(s: string): any {
  try {
    return JSON.parse(new TextDecoder().decode(unb64url(s)));
  } catch {
    throw new OidcError("malformed id_token");
  }
}

/** Validates signature (JWKS by kid), iss, aud, exp/iat/nbf, nonce, sub. Throws OidcError. */
export async function verifyIdToken(cfg: OidcConfig, idToken: string, expectedNonce: string): Promise<IdClaims> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new OidcError("malformed id_token");
  const header = decodePart(parts[0]!);
  const alg = header?.alg;
  // Allow-list: never "none", never HS*.
  if (typeof alg !== "string" || !(cfg.algs as string[]).includes(alg)) throw new OidcError("id_token alg not allowed");
  const params = ALG_PARAMS[alg as "RS256" | "ES256"];
  const kid = typeof header.kid === "string" ? header.kid : null;

  const pick = (keys: JsonWebKey[]) =>
    keys.find((k) => k.kty === params.kty && (k as any).kid === kid && (!k.use || k.use === "sig") && (!k.alg || k.alg === alg));
  let jwk = pick(await jwksKeys(cfg, false));
  if (!jwk) jwk = pick(await jwksKeys(cfg, true)); // unknown kid: one rate-limited refresh
  if (!jwk) throw new OidcError("no matching signing key");

  let key: CryptoKey;
  try {
    const { kid: _k, use: _u, alg: _a, key_ops: _o, ...pub } = jwk as any;
    key = await crypto.subtle.importKey("jwk", pub, params.import, false, ["verify"]);
  } catch {
    throw new OidcError("unusable signing key");
  }
  const ok = await crypto.subtle.verify(params.verify, key, unb64url(parts[2]!), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new OidcError("id_token signature invalid");

  const c = decodePart(parts[1]!);
  if (!c || typeof c !== "object") throw new OidcError("malformed id_token");
  const now = Math.floor(Date.now() / 1000);
  if (c.iss !== cfg.issuer) throw new OidcError("iss mismatch");
  const aud: unknown[] = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(cfg.clientId)) throw new OidcError("aud mismatch");
  if (aud.length > 1 && c.azp !== cfg.clientId) throw new OidcError("azp mismatch");
  if (typeof c.exp !== "number" || c.exp + SKEW_S <= now) throw new OidcError("id_token expired");
  if (typeof c.iat === "number" && c.iat - SKEW_S > now) throw new OidcError("id_token issued in the future");
  if (typeof c.nbf === "number" && c.nbf - SKEW_S > now) throw new OidcError("id_token not yet valid");
  if (typeof c.nonce !== "string" || c.nonce !== expectedNonce) throw new OidcError("nonce mismatch");
  if (typeof c.sub !== "string" || c.sub.length === 0 || c.sub.length > 255) throw new OidcError("sub missing");

  const s = (v: unknown) => (typeof v === "string" && v.length > 0 ? v.slice(0, 320) : null);
  return {
    sub: cfg.subKey === "issuer" ? `${cfg.issuer}#${c.sub}` : c.sub,
    email: s(c.email),
    emailVerified: c.email_verified === true,
    displayName: s(c.name) ?? s(c.preferred_username),
  };
}
