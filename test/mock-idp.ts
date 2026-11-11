import { vi } from "vitest";
import { b64url, resetOidcCaches, sha256b64url } from "../worker/lib/oidc.ts";

/**
 * A local, in-process OpenID provider. It answers discovery, JWKS and the token
 * endpoint by intercepting the Worker's outbound fetch (same isolate), with
 * keys generated here. No network, no external process.
 */
export const ISSUER = "https://idp.mock.test";
export const CLIENT_ID = "ituob-test-client";
export const CLIENT_SECRET = "test-secret-not-real";
export const REDIRECT = "http://localhost/auth/callback";

interface Key { kid: string; alg: "RS256" | "ES256"; priv: CryptoKey; jwk: JsonWebKey }
interface Code { nonce: string; challenge: string; redirectUri: string; claims: Record<string, unknown> }

async function genKey(kid: string, alg: "RS256" | "ES256"): Promise<Key> {
  const pair = (await crypto.subtle.generateKey(
    alg === "RS256"
      ? { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }
      : { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid, use: "sig", alg } as JsonWebKey;
  return { kid, alg, priv: pair.privateKey, jwk };
}

export class MockIdp {
  keys: Key[] = [];
  codes = new Map<string, Code>();
  calls: { url: string; method: string }[] = [];
  tokenRequests: { body: URLSearchParams; auth: string | null }[] = [];
  down = false;
  /** Claims merged into the next issued ID token (per-test overrides). */
  overrides: Record<string, unknown> = {};
  /** Mutates the signed token string after signing (tampering). */
  tamper: ((token: string) => string) | null = null;
  signWith: Key | null = null;
  profile: Record<string, unknown> = { sub: "idp-user-1", email: "u1@example.test", email_verified: true, name: "User One" };
  spy: ReturnType<typeof vi.spyOn> | null = null;

  async start() {
    this.codes.clear(); this.calls = []; this.tokenRequests = [];
    this.keys = [await genKey("k1", "RS256")];
    resetOidcCaches();
    const real = globalThis.fetch;
    this.spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
      const req = new Request(input, init);
      if (new URL(req.url).origin !== ISSUER) return real(input, init);
      return this.serve(req);
    });
  }
  stop() { this.spy?.mockRestore(); }

  async addKey(kid: string, alg: "RS256" | "ES256" = "RS256") {
    const k = await genKey(kid, alg);
    this.keys.push(k);
    return k;
  }

  private async serve(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    this.calls.push({ url: req.url, method: req.method });
    if (this.down) throw new TypeError("connection refused");
    if (path === "/.well-known/openid-configuration") {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
      });
    }
    if (path === "/jwks") return Response.json({ keys: this.keys.map((k) => k.jwk) });
    if (path === "/token" && req.method === "POST") return this.token(req);
    return new Response("not found", { status: 404 });
  }

  /** The user-agent side of /authorize: validates the request and returns the callback URL (with code). */
  async authorize(location: string, claims: Record<string, unknown> = this.profile): Promise<URL> {
    const u = new URL(location);
    if (u.origin + u.pathname !== `${ISSUER}/authorize`) throw new Error(`not the authorize endpoint: ${location}`);
    const q = u.searchParams;
    if (q.get("response_type") !== "code" || q.get("client_id") !== CLIENT_ID || q.get("code_challenge_method") !== "S256") throw new Error("bad authorize request");
    const code = b64url(crypto.getRandomValues(new Uint8Array(16)));
    this.codes.set(code, { nonce: q.get("nonce")!, challenge: q.get("code_challenge")!, redirectUri: q.get("redirect_uri")!, claims });
    const cb = new URL(q.get("redirect_uri")!);
    cb.searchParams.set("code", code);
    cb.searchParams.set("state", q.get("state")!);
    return cb;
  }

  private async token(req: Request): Promise<Response> {
    const body = new URLSearchParams(await req.formData() as unknown as Record<string, string>);
    const auth = req.headers.get("Authorization");
    this.tokenRequests.push({ body, auth });
    if (auth !== `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`) return Response.json({ error: "invalid_client" }, { status: 401 });
    const rec = this.codes.get(body.get("code") ?? "");
    this.codes.delete(body.get("code") ?? ""); // single use
    if (!rec || body.get("grant_type") !== "authorization_code" || body.get("redirect_uri") !== rec.redirectUri) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    if ((await sha256b64url(body.get("code_verifier") ?? "")) !== rec.challenge) return Response.json({ error: "invalid_grant", error_description: "PKCE" }, { status: 400 });
    const now = Math.floor(Date.now() / 1000);
    const payload = { iss: ISSUER, aud: CLIENT_ID, iat: now, exp: now + 300, nonce: rec.nonce, ...rec.claims, ...this.overrides };
    let id_token = await this.sign(payload);
    if (this.tamper) id_token = this.tamper(id_token);
    return Response.json({ access_token: "opaque", token_type: "Bearer", id_token });
  }

  async sign(payload: Record<string, unknown>, key: Key = this.signWith ?? this.keys[0]!): Promise<string> {
    const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
    const signingInput = `${enc({ alg: key.alg, kid: key.kid, typ: "JWT" })}.${enc(payload)}`;
    const params = key.alg === "RS256" ? { name: "RSASSA-PKCS1-v1_5" } : { name: "ECDSA", hash: "SHA-256" };
    const sig = await crypto.subtle.sign(params, key.priv, new TextEncoder().encode(signingInput));
    return `${signingInput}.${b64url(sig)}`;
  }
}
