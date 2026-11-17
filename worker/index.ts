// ituob.org Worker — the webapp foundation.
//
// Runs first for every request (run_worker_first); serves the static
// site through the ASSETS binding and handles everything that needs
// compute: apex→www canonicalization and the /api surface.
//
// Phase 1 (docs/cloudflare-webapp.adoc): read-only API. Phases 2–4
// add Access, D1, and the schema-form editor behind /api and /admin.

import { handleAuth } from "./lib/auth-routes.ts";
import { handleApi } from "./routes.ts";
import { flushOutbox, sweep, type NotifyMessage } from "./lib/outbox.ts";
import { getPublisher } from "./lib/publisher.ts";
import { reconcile } from "./lib/reconciler.ts";
import { handleQueue } from "./queue-consumer.ts";
import type { Env, RuntimeEnv } from "./lib/types.ts";

function hasDatabase(env: RuntimeEnv): env is Env {
  return !!env.DB;
}

const APEX_HOST = "ituob.org";

export default {
  async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.hostname === APEX_HOST) {
      url.hostname = `www.${url.hostname}`;
      return Response.redirect(url.toString(), 301);
    }

    if ((url.pathname.startsWith("/api/") || url.pathname === "/auth" || url.pathname.startsWith("/auth/")) && !hasDatabase(env)) {
      return Response.json({ error: "Webapp unavailable: DB binding is not configured." }, {
        status: 503, headers: { "Cache-Control": "no-store" },
      });
    }

    if (url.pathname.startsWith("/api/") && hasDatabase(env)) {
      const res = await handleApi(request, env, url);
      // After a committed write: hand queued notifications to the queue (a send, never an email).
      if (request.method !== "GET" && request.method !== "HEAD" && res.status < 400) {
        try { await flushOutbox(env); } catch (e) { console.log(JSON.stringify({ level: "error", event: "notify.flush_failed", error: String(e) })); }
      }
      return res;
    }

    if ((url.pathname === "/auth" || url.pathname.startsWith("/auth/")) && hasDatabase(env)) {
      return handleAuth(request, env, url);
    }

    return env.ASSETS.fetch(request);
  },
  async queue(batch: MessageBatch<NotifyMessage>, env: RuntimeEnv): Promise<void> {
    if (!hasDatabase(env)) {
      console.log(JSON.stringify({ level: "error", event: "notify.disabled", error: "DB binding is not configured" }));
      batch.retryAll();
      return;
    }
    await handleQueue(batch, env);
  },
  async scheduled(_e: ScheduledController, env: RuntimeEnv): Promise<void> {
    if (!hasDatabase(env)) {
      console.log(JSON.stringify({ level: "warn", event: "scheduled.disabled", error: "DB binding is not configured" }));
      return;
    }
    await sweep(env);
    // Repair lost webhooks. The real publisher is unconfigured until the App exists: that is a skip, not a crash.
    try {
      await reconcile(env.DB, getPublisher());
    } catch (e) {
      console.log(JSON.stringify({ level: "error", event: "reconcile.failed", error: String(e) }));
    }
  },
};
