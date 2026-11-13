import { editionNo } from "./lib/composer.ts";
import { readMetadata, saveMetadata, scheduleMetadata } from "./lib/edition-metadata.ts";
import { type Route, body, json } from "./lib/http.ts";
import { ituSession } from "./submission-routes.ts";

const path = "/api/admin/composer/editions/(\\d+)/metadata";
export const editionMetadataRoutes: Route[] = [
  { method: "GET", pattern: new RegExp(`^${path}$`), guard: "access", handler: async ({ env, access, params }) =>
    json({ ok: true, draft: await readMetadata(env.DB, await ituSession(env, access!), editionNo(params[0])) }) },
  { method: "POST", pattern: new RegExp(`^${path}$`), guard: "access", handler: async ({ request, env, access, params }) => {
    const input = await body(request);
    return json({ ok: true, draft: await saveMetadata(env.DB, await ituSession(env, access!), editionNo(params[0]), { metadata: input.metadata, expected_revision: input.expected_revision }) });
  } },
  { method: "POST", pattern: new RegExp(`^${path}/schedule$`), guard: "access", handler: async ({ request, env, access, params }) =>
    json({ ok: true, draft: await scheduleMetadata(env.DB, await ituSession(env, access!), editionNo(params[0]), (await body(request)).expected_revision) }) },
];
