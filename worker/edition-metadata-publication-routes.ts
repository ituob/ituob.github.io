import { editionNo } from "./lib/edition-number.ts";
import { openMetadataReview, readMetadataReview } from "./lib/edition-metadata-publication.ts";
import { type Route, body, json } from "./lib/http.ts";
import { InvalidError } from "./lib/membership.ts";
import { getPublisher } from "./lib/publisher.ts";
import { DEFAULT_PATCH_REPO } from "./lib/submissions.ts";
import { ituSession } from "./submission-routes.ts";

const path = "/api/admin/composer/editions/(\\d+)/metadata";
export const editionMetadataPublicationRoutes: Route[] = [
  { method: "POST", pattern: new RegExp(`^${path}/open-pr$`), guard: "access", handler: async ({ request, env, access, params }) => {
    const input = await body(request);
    if (typeof input.expected_revision !== "number" || !Number.isSafeInteger(input.expected_revision) || input.expected_revision < 1)
      throw new InvalidError("expected_revision must name the scheduled metadata revision");
    return json({ ok: true, ...await openMetadataReview(env.DB, await ituSession(env, access!), editionNo(params[0]), input.expected_revision,
      env.PATCH_REPO ?? DEFAULT_PATCH_REPO, getPublisher(env)) }, 202);
  } },
  { method: "GET", pattern: new RegExp(`^${path}/pr$`), guard: "access", handler: async ({ env, access, params }) =>
    json({ ok: true, ...await readMetadataReview(env.DB, await ituSession(env, access!), editionNo(params[0]), getPublisher(env)) }) },
];
