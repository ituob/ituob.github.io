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
import { flushOutbox, sweep } from "./lib/outbox.ts";
import { handleQueue } from "./queue-consumer.ts";
import type { Env } from "./lib/types.ts";

const APEX_HOST = "ituob.org";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.hostname === APEX_HOST) {
      url.hostname = `www.${url.hostname}`;
      return Response.redirect(url.toString(), 301);
    }

    if (url.pathname.startsWith("/api/")) {
      const res = await handleApi(request, env, url);
      // After a committed write: hand queued notifications to the queue (a send, never an email).
      if (request.method !== "GET" && request.method !== "HEAD" && res.status < 400) {
        try { await flushOutbox(env); } catch (e) { console.log(JSON.stringify({ level: "error", event: "notify.flush_failed", error: String(e) })); }
      }
      return res;
    }

    if (url.pathname === "/auth" || url.pathname.startsWith("/auth/")) {
      return handleAuth(request, env, url);
    }

    return env.ASSETS.fetch(request);
  },
  queue: handleQueue,
  async scheduled(_e: ScheduledController, env: Env): Promise<void> {
    await sweep(env);
  },
};
