import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getAccessIdentity, getSession, isLoopbackHost } from "../worker/lib/session.ts";
import { addUser, api, db, seedFixtures } from "./helpers.ts";

const hdr = { "X-Stub-Session": "itu-admin", "X-Stub-Access": "a@b.c" };

describe("the stub cannot run in production", () => {
  it("deployment configs only enable OIDC authentication and never embed the development stub", () => {
    const configs = (env as any).WRANGLER_CONFIGS as Record<string, string>;
    const files = Object.keys(configs);
    expect(files).toEqual(expect.arrayContaining(["wrangler.jsonc", "wrangler.staging.jsonc"]));
    for (const f of files) {
      const text = configs[f]!;
      const config = JSON.parse(text);
      expect(config.vars?.AUTH_MODE, f).toBe("oidc");
      for (const secret of ["OIDC_CLIENT_SECRET", "RESEND_API_KEY", "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET"]) {
        expect(config.vars, f).not.toHaveProperty(secret);
        if (secret !== "OIDC_CLIENT_SECRET" || config.vars.OIDC_CLIENT_AUTH !== "none")
          expect(config.secrets?.required, f).toContain(secret);
      }
      expect(text, f).not.toMatch(/stub/i);
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
    expect(["localhost", "127.0.0.1", "[::1]", "a.localhost"].every(isLoopbackHost)).toBe(true);
    expect(["ituob.org", "www.ituob.org", "localhost.ituob.org", "xlocalhost", "127.0.0.1.evil.com"].some(isLoopbackHost)).toBe(false);
  });
});
