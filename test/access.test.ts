import { beforeAll, describe, expect, it, vi } from "vitest";
import { verifyAccessIdentity } from "../worker/lib/access.ts";

const issuer = "https://unit-test.cloudflareaccess.com";
const config = { ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUD: "application-audience" };
const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
let pair: CryptoKeyPair;
let jwk: JsonWebKey;
beforeAll(async () => {
  pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  jwk = { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid: "current" } as JsonWebKey;
});
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
    expect(await verifyAccessIdentity(req, config, async () => Response.json({ keys: [jwk, jwk] }))).toBeNull();
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
