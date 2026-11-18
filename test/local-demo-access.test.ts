import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import worker from "../worker/index.ts";
import { createSession, SESSION_COOKIE } from "../worker/lib/session.ts";
import { activateMember, db, seedFixtures } from "./helpers.ts";

/** The generated local-demo environment: what scripts/dev-local.mjs puts in .local-dev/wrangler.json. */
const demoEnv = (extra: Record<string, unknown> = {}) => ({
  DB: env.DB, ASSETS: (env as any).ASSETS, NOTIFY_Q: (env as any).NOTIFY_Q,
  AUTH_MODE: "oidc", LOCAL_DEMO: "1", OIDC_ISSUER: "http://127.0.0.1:18788", OIDC_CLIENT_ID: "ituob-local-dev",
  OIDC_CLIENT_SECRET: "local-dev-secret-not-real", OIDC_CLIENT_AUTH: "basic", OIDC_REDIRECT_URI: "https://127.0.0.1:8443/auth/callback", ...extra,
}) as any;

async function adminGet(e: any, userId: string | null, host = "127.0.0.1") {
  const headers: Record<string, string> = { "Sec-Fetch-Site": "same-origin" };
  if (userId) headers.Cookie = `${SESSION_COOKIE}=${await createSession(db(), userId)}`;
  const res = await worker.fetch(new Request(`https://${host}/api/admin/general-messages`, { headers }), e, { waitUntil() {}, passThroughOnException() {} } as any);
  return res.status;
}

describe("local demo Access identity (dev:local only)", () => {
  it("lets the mock IdP session of an ITU admin through the existing Access routes", async () => {
    await seedFixtures();
    expect(await adminGet(demoEnv(), "bootstrap-admin")).toBe(200);
  });

  it("still lets the role checks refuse a member and an anonymous request", async () => {
    await seedFixtures();
    await activateMember("member-A", "A");
    expect(await adminGet(demoEnv(), "member-A")).toBe(403);
    expect(await adminGet(demoEnv(), "unaffiliated")).toBe(403);
    expect(await adminGet(demoEnv(), null)).toBe(403);
  });

  it("is inert without LOCAL_DEMO (a request that reaches the Worker without the flag is refused)", async () => {
    await seedFixtures();
    expect(await adminGet(demoEnv({ LOCAL_DEMO: undefined }), "bootstrap-admin")).toBe(403);
    expect(await adminGet(demoEnv({ LOCAL_DEMO: "true" }), "bootstrap-admin")).toBe(403);
  });

  it("is ignored on every non-loopback host", async () => {
    await seedFixtures();
    for (const host of ["www.ituob.org", "staging-www.ituob.org", "evil.example", "localhost.evil.example"])
      expect(await adminGet(demoEnv(), "bootstrap-admin", host), host).toBe(403);
  });

  it("is ignored when an Access application is configured, as in production", async () => {
    await seedFixtures();
    expect(await adminGet(demoEnv({ ACCESS_AUD: "aud", ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com" }), "bootstrap-admin")).toBe(403);
  });

  it("is ignored outside oidc mode", async () => {
    await seedFixtures();
    expect(await adminGet(demoEnv({ AUTH_MODE: undefined }), "bootstrap-admin")).toBe(403);
  });

  it("appears in no deployed Wrangler config, only in the generated local-demo one", () => {
    const configs = (env as any).WRANGLER_CONFIGS as Record<string, string>;
    for (const [name, text] of Object.entries(configs)) expect(text, name).not.toContain("LOCAL_DEMO");
  });
});
