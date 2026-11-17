import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAccessKeyCache, verifyAccessIdentity, verifyAccessPrincipal } from "../worker/lib/access.ts";
import { handleApi } from "../worker/routes.ts";
import type { Env } from "../worker/lib/types.ts";

const issuer = "https://unit-test.cloudflareaccess.com";
const config = { ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUD: "application-audience" };
const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
let pair: CryptoKeyPair;
let jwk: JsonWebKey;
beforeAll(async () => {
  pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  jwk = { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid: "current" } as JsonWebKey;
});
beforeEach(() => clearAccessKeyCache());
afterEach(() => { vi.useRealTimers(); });
async function token(overrides: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: "RS256", kid: "current", ...header })}.${encode({ iss: issuer, aud: [config.ACCESS_AUD], exp: now + 600, nbf: now - 10, email: "admin@example.org", ...overrides })}`;
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(unsigned)));
  return `${unsigned}.${btoa(String.fromCharCode(...sig)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")}`;
}
const request = (jwt: string) => new Request("https://www.ituob.org/api/admin/claims", { headers: { "Cf-Access-Jwt-Assertion": jwt, "Cf-Access-Authenticated-User-Email": "spoof@example.org" } });
const keys = () => vi.fn<typeof fetch>(async () => Response.json({ keys: [jwk] }));

describe("Cloudflare Access signed identity", () => {
  it("accepts an RS256 application token and reads only its signed email", async () => {
    const fetcher = keys();
    expect(await verifyAccessIdentity(request(await token()), config, fetcher)).toEqual({ email: "admin@example.org" });
    expect(fetcher).toHaveBeenCalledWith(`${issuer}/cdn-cgi/access/certs`, expect.objectContaining({ redirect: "error" }));
    expect(await verifyAccessIdentity(request(await token({ aud: config.ACCESS_AUD, email_verified: true })), config, fetcher)).toEqual({ email: "admin@example.org" });
  });
  it("never accepts a bare identity header or missing configuration", async () => {
    const fetcher = keys();
    const bare = new Request("https://www.ituob.org", { headers: { "Cf-Access-Authenticated-User-Email": "admin@example.org" } });
    expect(await verifyAccessIdentity(bare, config, fetcher)).toBeNull();
    expect(await verifyAccessIdentity(request(await token()), {}, fetcher)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    { iss: "https://attacker.cloudflareaccess.com" }, { aud: ["different-app"] },
    { exp: 1 }, { exp: undefined }, { exp: "9999999999" }, { nbf: 9999999999 }, { nbf: "0" }, { iat: 9999999999 },
    { email: undefined }, { email: "invalid" }, { email_verified: false },
  ])("rejects invalid claims %j", async (claims) => {
    expect(await verifyAccessIdentity(request(await token(claims)), config, keys())).toBeNull();
  });
  it("rejects altered payloads and signatures", async () => {
    const signed = await token();
    const parts = signed.split(".");
    parts[1] = encode({ iss: issuer, aud: config.ACCESS_AUD, exp: 9999999999, email: "attacker@example.org" });
    expect(await verifyAccessIdentity(request(parts.join(".")), config, keys())).toBeNull();
    expect(await verifyAccessIdentity(request(`${signed.slice(0, -8)}AAAAAAAA`), config, keys())).toBeNull();
  });
  it("rejects algorithm confusion, unknown keys, duplicate keys and unavailable JWKS", async () => {
    for (const header of [{ alg: "none" }, { alg: "HS256" }, { kid: "unknown" }, { crit: ["extension"] }]) {
      expect(await verifyAccessIdentity(request(await token({}, header)), config, keys())).toBeNull();
    }
    const req = request(await token());
    clearAccessKeyCache();
    expect(await verifyAccessIdentity(req, config, async () => Response.json({ keys: [jwk, jwk] }))).toBeNull();
    clearAccessKeyCache();
    expect(await verifyAccessIdentity(req, config, async () => new Response("down", { status: 503 }))).toBeNull();
    expect(await verifyAccessIdentity(req, config, async () => { throw new Error("offline"); })).toBeNull();
  });
  it("selects a rotated key by kid while preserving the previous published key", async () => {
    const current = { ...jwk, kid: "rotated" };
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ keys: [current, jwk] }));
    expect(await verifyAccessIdentity(request(await token()), config, fetcher)).toEqual({ email: "admin@example.org" });
    expect(await verifyAccessIdentity(request(await token({}, { kid: "rotated" })), config, fetcher)).toEqual({ email: "admin@example.org" });
  });
  it("never follows a token key URL or invalid configured origin", async () => {
    const fetcher = keys();
    expect(await verifyAccessIdentity(request("malformed"), config, fetcher)).toBeNull();
    expect(await verifyAccessIdentity(request(await token()), { ...config, ACCESS_TEAM_DOMAIN: "https://attacker.example" }, fetcher)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    expect(await verifyAccessIdentity(request(await token({}, { jku: "https://attacker.example/keys" })), config, fetcher)).toEqual({ email: "admin@example.org" });
    expect(fetcher).toHaveBeenCalledWith(`${issuer}/cdn-cgi/access/certs`, expect.anything());
  });
});


const ciConfig = { ...config, ACCESS_CI_CLIENT_IDS: " other-client, approved-ci " };
const ciClaims = { email: undefined, common_name: "approved-ci" };

describe("Cloudflare Access CI service principals", () => {
  it("accepts only explicitly allowlisted signed client IDs, without granting human identity", async () => {
    const req = request(await token(ciClaims));
    expect(await verifyAccessPrincipal(req, ciConfig, keys())).toEqual({ kind: "service", clientId: "approved-ci" });
    expect(await verifyAccessIdentity(req, ciConfig, keys())).toBeNull();
    for (const configured of [config, { ...config, ACCESS_CI_CLIENT_IDS: " , " }]) {
      expect(await verifyAccessPrincipal(req, configured, keys())).toBeNull();
    }
  });

  it.each(["unlisted-ci", "", null, 42])("rejects common_name %j even with a signed administrator email", async (common_name) => {
    const req = request(await token({ common_name }));
    expect(await verifyAccessPrincipal(req, ciConfig, keys())).toBeNull();
    expect(await verifyAccessIdentity(req, ciConfig, keys())).toBeNull();
  });

  it("never promotes a service token via signed email or forged identity headers", async () => {
    const req = request(await token({ common_name: "approved-ci" }));
    expect(await verifyAccessPrincipal(req, ciConfig, keys())).toEqual({ kind: "service", clientId: "approved-ci" });
    expect(await verifyAccessIdentity(req, ciConfig, keys())).toBeNull();
    const forged = new Request("https://www.ituob.org/api/ci/unknown", { headers: {
      "Cf-Access-Client-Id": "approved-ci", "Cf-Access-Authenticated-User-Email": "admin@example.org",
    } });
    expect(await verifyAccessPrincipal(forged, ciConfig, keys())).toBeNull();
  });

  it.each([{ iss: "https://attacker.cloudflareaccess.com" }, { aud: "another-app" }, { exp: 1 }, { nbf: 9999999999 }])(
    "validates the service-token claims %j", async (claims) => {
      expect(await verifyAccessPrincipal(request(await token({ ...ciClaims, ...claims })), ciConfig, keys())).toBeNull();
    },
  );

  it("requires a valid service-token signature", async () => {
    const signed = await token(ciClaims);
    expect(await verifyAccessPrincipal(request(`${signed.slice(0, -8)}AAAAAAAA`), ciConfig, keys())).toBeNull();
    const parts = signed.split(".");
    parts[1] = encode({ iss: issuer, aud: config.ACCESS_AUD, exp: 9999999999, common_name: "other-client" });
    expect(await verifyAccessPrincipal(request(parts.join(".")), ciConfig, keys())).toBeNull();
  });

  it("isolates service principals from admin/member/session APIs even with a user cookie", async () => {
    const jwt = await token({ common_name: "approved-ci" });
    const prepare = vi.fn(() => { throw new Error("database must not be consulted"); });
    const assets = vi.fn(async () => new Response("asset"));
    const env = { ...ciConfig, DB: { prepare }, ASSETS: { fetch: assets } } as unknown as Env;
    const fetcher = keys();
    vi.stubGlobal("fetch", fetcher);
    try {
      // Access routes: a service token is not a human administrator.
      for (const [method, path] of [["GET", "/api/admin/claims"], ["POST", "/api/admin/roster/import"], ["POST", "/api/admin/itu-staff"], ["GET", "/api/admin/composer/editions"]] as const) {
        const req = new Request(`https://www.ituob.org${path}`, { method, headers: {
          "Cf-Access-Jwt-Assertion": jwt, "Cf-Access-Authenticated-User-Email": "admin@example.org",
          Cookie: "__Host-ituob_session=existing-user-cookie", Origin: "https://www.ituob.org",
        } });
        expect((await handleApi(req, env, new URL(req.url))).status, path).toBe(403);
      }
      // Session routes: the Access token grants no session (no AUTH_MODE: unauthenticated); whoami stays anonymous.
      for (const path of ["/api/me/submissions", "/api/me/membership"]) {
        const req = new Request(`https://www.ituob.org${path}`, { headers: { "Cf-Access-Jwt-Assertion": jwt, Cookie: "__Host-ituob_session=existing-user-cookie" } });
        expect([401, 404], path).toContain((await handleApi(req, env, new URL(req.url))).status);
      }
      const who = await handleApi(new Request("https://www.ituob.org/api/whoami", { headers: { "Cf-Access-Jwt-Assertion": jwt } }), env, new URL("https://www.ituob.org/api/whoami"));
      expect(await who.json()).toEqual({ ok: true, authenticated: false });
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("authenticates the CI boundary and leaves all unknown paths non-mutating", async () => {
    const prepare = vi.fn(() => { throw new Error("database must not be consulted"); });
    const env = { ...ciConfig, DB: { prepare } } as unknown as Env;
    vi.stubGlobal("fetch", keys());
    try {
      const serviceJwt = await token(ciClaims);
      const humanJwt = await token();
      const unknownJwt = await token({ email: undefined, common_name: "unlisted-ci" });
      for (const jwt of [serviceJwt, humanJwt, unknownJwt, ""]) {
        for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]) {
          const req = new Request("https://www.ituob.org/api/ci/unknown", { method, headers: {
            "Cf-Access-Jwt-Assertion": jwt, "Cf-Access-Client-Id": "approved-ci",
            "Cf-Access-Authenticated-User-Email": "admin@example.org", Cookie: "__Host-ituob_session=existing-user-cookie",
          } });
          const res = await handleApi(req, env, new URL(req.url));
          expect(res.status).toBe(jwt === serviceJwt && ["GET", "HEAD"].includes(method) ? 404 : 403);
        }
      }
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("signature canonicality and JWKS caching", () => {
  it("rejects every non-canonical base64url variant of a valid signature", async () => {
    const signed = await token();
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let accepted = 0;
    for (const c of alphabet) {
      const variant = `${signed.slice(0, -1)}${c}`;
      if (await verifyAccessIdentity(request(variant), config, keys())) accepted++;
    }
    expect(accepted).toBe(1); // only the canonical original
    expect(await verifyAccessIdentity(request(`${signed}=`), config, keys())).toBeNull();
  });
  it("caches the JWKS per team domain across requests", async () => {
    const f = keys();
    for (let i = 0; i < 5; i++) expect(await verifyAccessIdentity(request(await token()), config, f)).not.toBeNull();
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("refetches an unknown kid at most once per interval, and again after it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = keys();
    await verifyAccessIdentity(request(await token()), config, f); // primes
    for (let i = 0; i < 5; i++) expect(await verifyAccessIdentity(request(await token({}, { kid: "unknown" })), config, f)).toBeNull();
    expect(f).toHaveBeenCalledTimes(1); // within the miss interval: no refetch storm
    vi.setSystemTime(Date.now() + 31_000);
    await verifyAccessIdentity(request(await token({}, { kid: "unknown" })), config, f);
    await verifyAccessIdentity(request(await token({}, { kid: "unknown" })), config, f);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("expires the cache after the TTL and does not cache failures", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = keys();
    await verifyAccessIdentity(request(await token()), config, f);
    vi.setSystemTime(Date.now() + 11 * 60_000);
    await verifyAccessIdentity(request(await token({ exp: Math.floor(Date.now() / 1000) + 600, nbf: Math.floor(Date.now() / 1000) - 10 })), config, f);
    expect(f).toHaveBeenCalledTimes(2);
    clearAccessKeyCache();
    const down = vi.fn<typeof fetch>(async () => new Response("x", { status: 503 }));
    expect(await verifyAccessIdentity(request(await token()), config, down)).toBeNull();
    expect(await verifyAccessIdentity(request(await token()), config, down)).toBeNull();
    expect(down).toHaveBeenCalledTimes(2);
  });
});
