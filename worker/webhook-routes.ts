// GitHub App webhook receiver. Public guard: no session, no CSRF check; the
// trust path is the HMAC signature on the raw body (worker/lib/github-webhook.ts).
import { handleWebhook } from "./lib/github-webhook.ts";
import type { Route } from "./lib/http.ts";

export const webhookRoutes: Route[] = [
  { method: "POST", pattern: /^\/api\/github\/webhook$/, guard: "public", handler: ({ request, env }) => handleWebhook(request, env) },
];
