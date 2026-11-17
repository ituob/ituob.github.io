import { proposeCatalogEntry, readCatalogView } from "./lib/catalog-entries.ts";
import { type Route, body, json } from "./lib/http.ts";
import { InvalidError } from "./lib/membership.ts";
import { ituSession } from "./submission-routes.ts";

const base = "/api/admin/catalog";
export const catalogRoutes: Route[] = [
  { method: "GET", pattern: new RegExp(`^${base}$`), guard: "access",
    handler: async ({ env, access }) => json({ ok: true, ...(await readCatalogView(env, await ituSession(env, access!))) }) },
  { method: "POST", pattern: new RegExp(`^${base}/registers$`), guard: "access",
    handler: async ({ request, env, access }) => {
      const session = await ituSession(env, access!);
      return json({ ok: true, pending: true, ...(await proposeCatalogEntry(env, session, await body(request))) }, 202);
    } },
  // The id in the path is the register being edited; a different id in the body is refused, never applied.
  { method: "PUT", pattern: new RegExp(`^${base}/registers/([^/]+)$`), guard: "access",
    handler: async ({ request, env, access, params }) => {
      const session = await ituSession(env, access!);
      let id: string;
      try { id = decodeURIComponent(params[0]!); } catch { throw new InvalidError("malformed register id"); }
      return json({ ok: true, pending: true, ...(await proposeCatalogEntry(env, session, await body(request), id)) }, 202);
    } },
];
