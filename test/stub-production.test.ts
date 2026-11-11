import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getAccessIdentity, getSession, isLoopbackHost } from "../worker/lib/session.ts";
import { addUser, api, db, seedFixtures } from "./helpers.ts";

const hdr = { "X-Stub-Session": "itu-admin", "X-Stub-Access": "a@b.c" };

describe("the stub cannot run in production", () => {
  it("no wrangler config sets AUTH_MODE, vars or the stub", () => {
    const configs = (env as any).WRANGLER_CONFIGS as Record<string, string>;
    const files = Object.keys(configs);
    expect(files).toEqual(expect.arrayContaining(["wrangler.jsonc", "wrangler.staging.jsonc"]));
    for (const f of files) {
      const text = configs[f]!;
      expect(text, f).not.toMatch(/AUTH_MODE/);
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
    const r = await api("POST", "/api/admin/itu-staff", { host: "www.ituob.org", headers: hdr, body: { userId: "itu-admin", roles: ["itu-admin"] } });
    expect(r.status).toBe(500);
    const rows = await db().prepare("SELECT count(*) n FROM memberships").first<{ n: number }>();
    expect(rows!.n).toBe(0);
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
