import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { addUser, db } from "./helpers.ts";
import { flushOutbox } from "../worker/lib/outbox.ts";
import type { Env } from "../worker/lib/types.ts";
import worker from "../worker/index.ts";
import type { RuntimeEnv } from "../worker/lib/types.ts";
import type { NotifyMessage } from "../worker/lib/outbox.ts";

const staticEnv = (): RuntimeEnv => ({ ASSETS: { fetch: async () => new Response("static asset") } });

describe("unprovisioned bindings", () => {
  it("serves static assets and canonical redirects without DB or queue", async () => {
    const env = staticEnv();
    expect(await (await worker.fetch(new Request("https://www.ituob.org/"), env)).text()).toBe("static asset");
    const redirect = await worker.fetch(new Request("https://ituob.org/docs?a=1"), env);
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get("Location")).toBe("https://www.ituob.org/docs?a=1");
  });

  it("returns a clear uncached 503 for API and auth when DB is absent", async () => {
    for (const path of ["/api/whoami", "/api/github/webhook", "/auth", "/auth/login", "/auth/callback", "/auth/logout"]) {
      const response = await worker.fetch(new Request(`https://www.ituob.org${path}`), staticEnv());
      expect(response.status, path).toBe(503);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toEqual({ error: "Webapp unavailable: DB binding is not configured." });
    }
  });

  it("keeps outbox rows queued when the queue binding is absent", async () => {
    await addUser("outbox-user");
    await db().prepare(`INSERT INTO notifications (id,user_id,kind,dedupe_key,payload,created_at,email_status)
      VALUES ('pending','outbox-user','test','pending','{}','t','queued')`).run();
    expect(await flushOutbox({ ...env, NOTIFY_Q: undefined } as Env)).toBe(0);
    expect(await db().prepare("SELECT email_status, enqueued_at FROM notifications WHERE id='pending'").first())
      .toEqual({ email_status: "queued", enqueued_at: null });
  });

  it("skips scheduled work with a clear diagnostic when DB is absent", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(worker.scheduled({} as ScheduledController, staticEnv())).resolves.toBeUndefined();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('"event":"scheduled.disabled"'));
    } finally { log.mockRestore(); }
  });

  it("retries queue messages without loss when DB is absent", async () => {
    const retryAll = vi.fn();
    const ack = vi.fn();
    const batch = { messages: [{ body: { notification_ids: ["n1"] }, ack }], retryAll } as unknown as MessageBatch<NotifyMessage>;
    await worker.queue(batch, staticEnv());
    expect(retryAll).toHaveBeenCalledOnce();
    expect(ack).not.toHaveBeenCalled();
  });
});
