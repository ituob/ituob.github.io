// ituob.org Worker — the webapp foundation.
//
// Runs first for every request (run_worker_first); serves the static
// site through the ASSETS binding and handles everything that needs
// compute: apex→www canonicalization and the /api surface.
//
// Phase 1 (docs/cloudflare-webapp.adoc): read-only API. Phases 2–4
// add Access, D1, and the schema-form editor behind /api and /admin.

import { legacyRedirectTarget } from "./lib/legacy-redirects.ts";
import { handleAuth } from "./lib/auth-routes.ts";
import { handleApi } from "./routes.ts";
import { flushOutbox, sweep, type NotifyMessage } from "./lib/outbox.ts";
import { getPublisher } from "./lib/publisher.ts";
import { reconcile } from "./lib/reconciler.ts";
import { handleQueue } from "./queue-consumer.ts";
import { getAccessIdentity, StubMisconfigured } from "./lib/session.ts";
import { ituSession } from "./submission-routes.ts";
import { Forbidden, requireRole } from "./lib/authz.ts";
import type { Env, RuntimeEnv } from "./lib/types.ts";
import { NOT_AVAILABLE_MESSAGE } from "./lib/not-available.ts";

function hasDatabase(env: RuntimeEnv): env is Env {
  return !!env.DB;
}

const APEX_HOST = "ituob.org";


// Public-only profile (no DB binding): the read-only site is complete, the account surface is not
// deployed. Answer plainly (404, never cached) instead of a raw 503; browsers get a small page.
function notAvailableYet(request: Request): Response {
  const headers = { "Cache-Control": "no-store" };
  if (request.headers.get("Accept")?.includes("text/html")) {
    const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Not available yet</title></head><body><h1>Not available yet</h1><p>${NOT_AVAILABLE_MESSAGE}</p><p><a href="/">Return to the home page</a></p></body></html>`;
    return new Response(body, { status: 404, headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
  }
  return Response.json({ error: NOT_AVAILABLE_MESSAGE, code: "not_available_yet" }, { status: 404, headers });
}

export default {
  async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    const url = new URL(request.url);

    const legacyTarget = legacyRedirectTarget(url.pathname);
    if (legacyTarget || url.hostname === APEX_HOST || (url.protocol === "http:" && url.hostname === "www.ituob.org")) {
      if (legacyTarget) url.pathname = legacyTarget;
      if (url.hostname === APEX_HOST) url.hostname = `www.${url.hostname}`;
      url.protocol = "https:";
      return Response.redirect(url.toString(), 301);
    }

    if ((url.pathname.startsWith("/api/") || url.pathname === "/auth" || url.pathname.startsWith("/auth/")) && !hasDatabase(env)) {
      return notAvailableYet(request);
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

    // Worker-first routing must preserve the admin gate even if an Access
    // application is accidentally omitted from the edge configuration.
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      if (!hasDatabase(env)) return notAvailableYet(request);
      try {
        const access = await getAccessIdentity(request, env);
        if (!access) return new Response("Forbidden", { status: 403 });
        requireRole(await ituSession(env, access), "itu-admin", "itu-editor");
      } catch (error) {
        if (error instanceof StubMisconfigured) return new Response("Server misconfigured", { status: 500 });
        if (error instanceof Forbidden) return new Response("Forbidden", { status: 403 });
        throw error;
      }
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
  async scheduled(event: ScheduledController, env: RuntimeEnv): Promise<void> {
    if (!hasDatabase(env)) {
      console.log(JSON.stringify({ level: "warn", event: "scheduled.disabled", error: "DB binding is not configured" }));
      return;
    }
    await sweep(env, event.scheduledTime ?? Date.now());
    // Repair lost webhooks with the configured installation-scoped publisher.
    try {
      await reconcile(env.DB, getPublisher(env));
    } catch (e) {
      console.log(JSON.stringify({ level: "error", event: "reconcile.failed", error: String(e) }));
    }
  },
};
