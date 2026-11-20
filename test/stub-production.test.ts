import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getAccessIdentity, getSession, isLoopbackHost } from "../worker/lib/session.ts";
import { addUser, api, db, seedFixtures } from "./helpers.ts";

const hdr = { "X-Stub-Session": "itu-admin", "X-Stub-Access": "a@b.c" };

describe("the stub cannot run in production", () => {
  it("live deployment configs stay static-safe, public-only and keep credentials out of vars", () => {
    const configs = (env as any).WRANGLER_CONFIGS as Record<string, string>;
    const files = Object.keys(configs);
    const liveFiles = ["wrangler.jsonc", "wrangler.staging.jsonc"];
    expect(files).toEqual(expect.arrayContaining([...liveFiles, "wrangler.bindings.example.jsonc", "wrangler.staging.bindings.example.jsonc"]));
    for (const f of liveFiles) {
      const text = configs[f]!;
      const config = JSON.parse(text);
      expect(config.vars ?? {}, f).not.toHaveProperty("AUTH_MODE");
      expect(config.d1_databases ?? [], f).toHaveLength(0);
      expect(config.queues?.producers ?? [], f).toHaveLength(0);
      expect(config.queues?.consumers ?? [], f).toHaveLength(0);
      expect(config.triggers?.crons ?? [], f).toHaveLength(0);
      // Public-only profile: no provider secrets are required to deploy; the full profile generates them.
      expect(config.secrets?.required ?? [], f).toHaveLength(0);
      for (const secret of ["OIDC_CLIENT_SECRET", "RESEND_API_KEY", "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET"])
        expect(config.vars ?? {}, f).not.toHaveProperty(secret);
      expect(text, f).not.toMatch(/stub/i);
    }
    for (const f of ["wrangler.bindings.example.jsonc", "wrangler.staging.bindings.example.jsonc"]) {
      const text = configs[f]!;
      expect(text, f).not.toMatch(/AUTH_MODE|stub/i);
      expect(text, f).not.toMatch(/"vars"\s*:/);
      for (const secret of ["OIDC_CLIENT_SECRET", "RESEND_API_KEY", "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET"])
        expect(text, f).not.toContain(`"${secret}"`);
    }
  });

  it("AUTH_MODE=stub on any non-loopback host never yields a session or Access identity", async () => {
    await seedFixtures();
    for (const host of ["www.ituob.org", "ituob.org", "staging-www.ituob.org", "evil.example", "localhost.evil.example"]) {
      const req = new Request(`https://${host}/api/x`, { headers: hdr });
      await expect(getSession(req, env as any), host).rejects.toThrow(/loopback/);
      await expect(getAccessIdentity(req, env as any), host).rejects.toThrow(/loopback/);
    }
  });

  it("the Worker answers 500 (not a session) for stub config on a production host", async () => {
    await seedFixtures();
    const before = (await db().prepare("SELECT * FROM memberships ORDER BY id").all()).results;
    const r = await api("POST", "/api/admin/itu-staff", { host: "www.ituob.org", headers: hdr, body: { userId: "itu-admin", roles: ["itu-admin"] } });
    expect(r.status).toBe(500);
    expect((await db().prepare("SELECT * FROM memberships ORDER BY id").all()).results).toEqual(before);
    expect((await api("GET", "/api/whoami", { host: "www.ituob.org", headers: hdr })).status).toBe(500);
  });

  it("without AUTH_MODE=stub, even loopback is fail-closed (null session)", async () => {
    await addUser("u");
    const req = new Request("http://localhost/x", { headers: { "X-Stub-Session": "u", "X-Stub-Access": "a@b.c" } });
    for (const mode of [undefined, "oidc", "", "STUB"]) {
      const e = { ...env, AUTH_MODE: mode } as any;
      expect(await getSession(req, e)).toBeNull();
      expect(await getAccessIdentity(req, e)).toBeNull();
    }
  });

  it("loopback allow-list is exact", () => {
    expect(["localhost", "127.0.0.1", "[::1]"].every(isLoopbackHost)).toBe(true);
    expect(["ituob.org", "www.ituob.org", "localhost.ituob.org", "xlocalhost", "127.0.0.1.evil.com", "a.localhost", "evil.localhost"].some(isLoopbackHost)).toBe(false);
  });
});
