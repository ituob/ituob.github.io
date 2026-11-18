// GitHub App webhook receiver. Public guard: no session, no CSRF check; the
// trust path is the HMAC signature on the raw body (worker/lib/github-webhook.ts).
import { handleWebhook } from "./lib/github-webhook.ts";
import { handleFeedbackWebhook } from "./lib/email-feedback.ts";
import type { Route } from "./lib/http.ts";

export const webhookRoutes: Route[] = [
  { method: "POST", pattern: /^\/api\/github\/webhook$/, guard: "public", handler: ({ request, env }) => handleWebhook(request, env) },
  // Email provider bounce/complaint feedback: public guard, trust path is the signature (worker/lib/email-feedback.ts).
  { method: "POST", pattern: /^\/api\/email\/webhook$/, guard: "public", handler: ({ request, env }) => handleFeedbackWebhook(request, env) },
];
