// Admin composer routes (#103). Every route is Access-guarded (/api/admin/*), and composer.ts
// additionally requires the itu-admin role, resolved server-side from the Access email.
import { editionNo, listEditions, listMergedUnpublished, openEdition, placeItem, publishEdition, readEdition, removeItem } from "./lib/composer.ts";
import { type Route, body, json } from "./lib/http.ts";
import { InvalidError } from "./lib/membership.ts";
import { getPublisher } from "./lib/publisher.ts";
import { reconcile } from "./lib/reconciler.ts";
import { requireRole } from "./lib/authz.ts";
import { ituSession } from "./submission-routes.ts";

const ID = "([0-9A-Z]{26})";
const re = (s: string) => new RegExp(`^${s}$`);

export const composerRoutes: Route[] = [
  { method: "GET", pattern: re("/api/admin/composer/submissions"), guard: "access",
    handler: async ({ env, access }) => json({ ok: true, submissions: await listMergedUnpublished(env.DB, await ituSession(env, access!)) }) },
  { method: "GET", pattern: re("/api/admin/composer/editions"), guard: "access",
    handler: async ({ env, access }) => json({ ok: true, editions: await listEditions(env.DB, await ituSession(env, access!)) }) },
  { method: "POST", pattern: re("/api/admin/composer/editions"), guard: "access",
    handler: async ({ request, env, access }) => {
      const s = await ituSession(env, access!);
      const r = await openEdition(env.DB, s, editionNo((await body(request)).ob_issue_no));
      return json({ ok: true, ...r }, r.created ? 201 : 200);
    } },
  { method: "GET", pattern: re("/api/admin/composer/editions/(\\d+)"), guard: "access",
    handler: async ({ env, access, params }) => json({ ok: true, ...(await readEdition(env.DB, await ituSession(env, access!), editionNo(params[0]))) }) },
  { method: "POST", pattern: re("/api/admin/composer/editions/(\\d+)/items"), guard: "access",
    handler: async ({ request, env, access, params }) => {
      const id = (await body(request)).submission_id;
      if (typeof id !== "string") throw new InvalidError("submission_id required");
      return json({ ok: true, submission: await placeItem(env.DB, await ituSession(env, access!), editionNo(params[0]), id) });
    } },
  { method: "POST", pattern: re(`/api/admin/composer/editions/(\\d+)/items/${ID}/remove`), guard: "access",
    handler: async ({ env, access, params }) =>
      json({ ok: true, submission: await removeItem(env.DB, await ituSession(env, access!), editionNo(params[0]), params[1]!) }) },
  { method: "POST", pattern: re("/api/admin/composer/editions/(\\d+)/publish"), guard: "access",
    handler: async ({ env, access, params }) =>
      json({ ok: true, ...(await publishEdition(env.DB, await ituSession(env, access!), editionNo(params[0]), getPublisher())) }) },
  { method: "POST", pattern: re("/api/admin/reconcile"), guard: "access",
    handler: async ({ env, access }) => {
      requireRole(await ituSession(env, access!), "itu-admin");
      return json({ ok: true, ...(await reconcile(env.DB, getPublisher())) });
    } },
];
