// ituob.org Worker — the webapp foundation.
//
// Runs first for every request (run_worker_first); serves the static
// site through the ASSETS binding and handles everything that needs
// compute: apex→www canonicalization and the /api surface.
//
// Phase 1 (docs/cloudflare-webapp.adoc): read-only API. Phases 2–4
// add Access, D1, and the schema-form editor behind /api and /admin.

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

const APEX_HOST = "ituob.org";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.hostname === APEX_HOST) {
      url.hostname = `www.${url.hostname}`;
      return Response.redirect(url.toString(), 301);
    }

    if (url.pathname === "/api/health") {
      return Response.json({
        ok: true,
        service: "ituob-org",
        version: "phase-1",
      });
    }

    if (url.pathname.startsWith("/api/")) {
      return Response.json({ error: "not found" }, { status: 404 });
    }

    // Citable entry pages: one shell per register renders any
    // /registers/{slug}/entries/{key}/ from the register's
    // entries.json, so entries never need one static file each.
    const entryMatch = url.pathname.match(/^\/registers\/([a-z0-9-]+)\/entries\/([^/]+)\/?$/);
    if (entryMatch) {
      return env.ASSETS.fetch(
        new Request(new URL(`/registers/${entryMatch[1]}/entries/`, url.origin), request),
      );
    }

    return env.ASSETS.fetch(request);
  },
};
