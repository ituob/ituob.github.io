import type { AccessIdentity, AccessPrincipal } from "./types.ts";

/** Cloudflare Access application-token verification; no request identity header is trusted. */
export interface AccessConfig {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** Comma-separated Access service-token client IDs; absent means none allowed. */
  ACCESS_CI_CLIENT_IDS?: string;
}

type SigningKey = JsonWebKey & { kid?: string };

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const JWKS_TTL_MS = 10 * 60 * 1000;
const JWKS_MISS_REFETCH_MS = 30 * 1000;
const jwksCache = new Map<string, { keys: SigningKey[]; at: number }>();
/** Test hook: drop all cached key sets. */
export function clearAccessKeyCache(): void {
  jwksCache.clear();
}

async function fetchKeys(origin: string, fetcher: typeof fetch): Promise<SigningKey[] | null> {
  const response = await fetcher(`${origin}/cdn-cgi/access/certs`, { redirect: "error", signal: AbortSignal.timeout(5000) });
  if (!response.ok) return null;
  const jwks = await response.json() as { keys?: SigningKey[] };
  if (!Array.isArray(jwks.keys)) return null;
  jwksCache.set(origin, { keys: jwks.keys, at: Date.now() });
  return jwks.keys;
}

/** Cached per team origin; an unknown kid refetches at most once per JWKS_MISS_REFETCH_MS. */
async function keysFor(origin: string, kid: string, fetcher: typeof fetch): Promise<SigningKey[] | null> {
  const hit = jwksCache.get(origin);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (hit && age < JWKS_TTL_MS && (hit.keys.some((k) => k.kid === kid) || age < JWKS_MISS_REFETCH_MS)) return hit.keys;
  return fetchKeys(origin, fetcher);
}

function decode(segment: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new Error("invalid base64url");
  const binary = atob(segment.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/**
 * The configured team origin, never a URL supplied by the JWT, selects the JWKS.
 * A signed common_name selects a service principal and must be allowlisted.
 * A verified signed email is required for a human administrator. Access does not
 * normally emit email_verified; an explicit false value is rejected if present.
 */
export async function verifyAccessPrincipal(
  request: Request,
  config: AccessConfig,
  fetcher: typeof fetch = fetch,
): Promise<AccessPrincipal | null> {
  try {
    const domain = config.ACCESS_TEAM_DOMAIN;
    const audience = config.ACCESS_AUD;
    if (!domain || !audience?.trim()) return null;
    const issuer = new URL(domain.includes("://") ? domain : `https://${domain}`);
    if (issuer.protocol !== "https:" || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer.hostname)
      || issuer.port || issuer.username || issuer.password || issuer.pathname !== "/" || issuer.search || issuer.hash) return null;

    const token = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!token || token.length > 16384) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
    const header = JSON.parse(new TextDecoder().decode(decode(headerPart)));
    const claims = JSON.parse(new TextDecoder().decode(decode(payloadPart)));
    if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid || header.crit !== undefined) return null;
    const now = Date.now() / 1000;
    if (claims.iss !== issuer.origin || !Number.isFinite(claims.exp) || claims.exp <= now
      || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now))
      || (claims.iat !== undefined && (!Number.isFinite(claims.iat) || claims.iat > now))) return null;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.every((a: unknown) => typeof a === "string") || !audiences.includes(audience)) return null;
    let principal: AccessPrincipal;
    if (claims.common_name !== undefined) {
      const allowed = config.ACCESS_CI_CLIENT_IDS?.split(",").map((id) => id.trim()).filter(Boolean) ?? [];
      if (typeof claims.common_name !== "string" || !allowed.includes(claims.common_name)) return null;
      principal = { kind: "service", clientId: claims.common_name };
    } else {
      if (typeof claims.email !== "string" || claims.email.length > 254
        || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email)
        || (claims.email_verified !== undefined && claims.email_verified !== true)) return null;
      principal = { email: claims.email };
    }

    const signature = decode(signaturePart);
    if (encode(signature) !== signaturePart) return null; // non-canonical base64url
    const keys = await keysFor(issuer.origin, header.kid, fetcher);
    if (!keys) return null;
    const matches = keys.filter((k) => k.kid === header.kid && k.kty === "RSA"
      && (k.alg === undefined || k.alg === "RS256") && (k.use === undefined || k.use === "sig")
      && (k.key_ops === undefined || k.key_ops.includes("verify")));
    if (matches.length !== 1) return null;
    const key = await crypto.subtle.importKey("jwk", matches[0]!, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, new TextEncoder().encode(`${headerPart}.${payloadPart}`));
    return valid ? principal : null;
  } catch {
    // Malformed tokens, unavailable keys and cryptographic errors all fail closed.
    return null;
  }
}

/** Human-only adapter: service tokens can never become administrators via email. */
export async function verifyAccessIdentity(
  request: Request,
  config: AccessConfig,
  fetcher: typeof fetch = fetch,
): Promise<AccessIdentity | null> {
  const principal = await verifyAccessPrincipal(request, config, fetcher);
  return principal && "email" in principal ? principal : null;
}
