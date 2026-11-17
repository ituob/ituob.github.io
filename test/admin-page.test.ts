import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../worker/index.ts";
import { provisionItu, seedFixtures } from "./helpers.ts";

beforeEach(seedFixtures);

describe("admin asset gate", () => {
  const request = (headers: Record<string, string> = {}, path = "/admin/editor/") => new Request(`http://localhost${path}`, { headers });
  const bindings = () => ({ ...env, ASSETS: { fetch: async () => new Response("Admin shell") } });

  it("rejects direct asset requests without an Access identity", async () => {
    expect((await worker.fetch(request(), bindings())).status).toBe(403);
    expect((await worker.fetch(request({}, "/admin"), bindings())).status).toBe(403);
    expect((await worker.fetch(request({ "X-Stub-Session": "itu-admin" }), bindings())).status).toBe(403);
  });

  it("requires an active ITU role after Access authentication", async () => {
    expect((await worker.fetch(request({ "X-Stub-Access": "unaffiliated@example.test" }), bindings())).status).toBe(403);
    await provisionItu("itu-editor", ["itu-editor"]);
    const response = await worker.fetch(request({ "X-Stub-Access": "itu-editor@example.test" }), bindings());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Admin shell");
  });

  it("does not gate public assets behind staff authentication", async () => {
    expect((await worker.fetch(request({}, "/about/"), bindings())).status).toBe(200);
  });
});
