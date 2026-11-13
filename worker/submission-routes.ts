// Submission workflow routes (#103). Member actions sit under the
// session-guarded /api/me/*; ITU review/approval under Access-guarded /api/admin/*.
import { Forbidden } from "./lib/authz.ts";
import { type Route, body, json } from "./lib/http.ts";
import { resolveAuthority } from "./lib/authority.ts";
import { getPublisher } from "./lib/publisher.ts";
import { requestRevert } from "./lib/revert.ts";
import {
  DEFAULT_PATCH_REPO, adminWithdraw, approve, createSubmission, editDraft, listSubmissions, openPr,
  getSub, readSubmission, reviewMove, reviseSubmission, submitDraft, withdrawOwn,
} from "./lib/submissions.ts";
import type { AccessIdentity, Env, Session } from "./lib/types.ts";

const ID = "([0-9A-Z]{26})";
const re = (s: string) => new RegExp(`^${s}$`);

/**
 * Access identity is an email; in-app roles belong to the users row with that
 * email (Access identity and in-app roles are not auto-linked: the role check
 * is repeated here, server-side).
 */
export async function ituSession(env: Env, access: AccessIdentity): Promise<Session> {
  const u = await env.DB.prepare(`SELECT id FROM users WHERE lower(email) = lower(?1)`).bind(access.email).first<{ id: string }>();
  if (!u) throw new Forbidden();
  return { userId: u.id, ...(await resolveAuthority(env.DB, u.id)) };
}

export const submissionRoutes: Route[] = [
  { method: "GET", pattern: re("/api/me/submissions"), guard: "session",
    handler: async ({ env, session, url }) => json({ ok: true, submissions: await listSubmissions(env.DB, session, url.searchParams.get("state"), false) }) },
  { method: "POST", pattern: re("/api/me/submissions"), guard: "session",
    handler: async ({ request, env, session }) => json({ ok: true, submission: await createSubmission(env.DB, session, await body(request)) }, 201) },
  { method: "GET", pattern: re(`/api/me/submissions/${ID}`), guard: "session",
    handler: async ({ env, session, params }) => json({ ok: true, ...(await readSubmission(env.DB, session, params[0]!)) }) },
  { method: "PUT", pattern: re(`/api/me/submissions/${ID}`), guard: "session",
    handler: async ({ request, env, session, params }) => json({ ok: true, submission: await editDraft(env.DB, session, params[0]!, await body(request)) }) },
  { method: "POST", pattern: re(`/api/me/submissions/${ID}/submit`), guard: "session",
    handler: async ({ env, session, params }) => json({ ok: true, submission: await submitDraft(env.DB, session, params[0]!) }) },
  { method: "POST", pattern: re(`/api/me/submissions/${ID}/revise`), guard: "session",
    handler: async ({ request, env, session, params }) => json({ ok: true, submission: await reviseSubmission(env.DB, session, params[0]!, await body(request)) }) },
  { method: "POST", pattern: re(`/api/me/submissions/${ID}/withdraw`), guard: "session",
    handler: async ({ request, env, session, params }) => {
      const r = (await body(request)).reason;
      return json({ ok: true, submission: await withdrawOwn(env.DB, session, params[0]!, typeof r === "string" ? r : null) });
    } },

  { method: "GET", pattern: re("/api/admin/submissions"), guard: "access",
    handler: async ({ env, access, url }) =>
      json({ ok: true, submissions: await listSubmissions(env.DB, await ituSession(env, access!), url.searchParams.get("state"), true) }) },
  { method: "GET", pattern: re(`/api/admin/submissions/${ID}`), guard: "access",
    handler: async ({ env, access, params }) => json({ ok: true, ...(await readSubmission(env.DB, await ituSession(env, access!), params[0]!)) }) },
  ...(["start-review", "request-changes", "reject"] as const).map((verb): Route => ({
    method: "POST", pattern: re(`/api/admin/submissions/${ID}/${verb}`), guard: "access",
    handler: async ({ request, env, access, params }) =>
      json({ ok: true, submission: await reviewMove(env.DB, await ituSession(env, access!), params[0]!, verb.replace("-", "_") as "start_review", await body(request)) }),
  })),
  { method: "POST", pattern: re(`/api/admin/submissions/${ID}/approve`), guard: "access",
    handler: async ({ request, env, access, params }) => {
      const sub = await approve(env.DB, await ituSession(env, access!), params[0]!, await body(request), env.PATCH_REPO ?? DEFAULT_PATCH_REPO);
      // The consumer runs after the approval is durable; a GitHub failure leaves pr_pending + last_error.
      const pr = await openPr(env.DB, getPublisher(env), sub.id);
      return json({ ok: true, submission: { ...sub, state: pr.state }, pr }, pr.error ? 202 : 200);
    } },
  { method: "POST", pattern: re(`/api/admin/submissions/${ID}/open-pr`), guard: "access",
    handler: async ({ env, access, params }) => {
      await ituSession(env, access!);
      const pr = await openPr(env.DB, getPublisher(env), params[0]!);
      return json({ ok: true, pr }, pr.error ? 202 : 200);
    } },
  { method: "POST", pattern: re(`/api/admin/submissions/${ID}/withdraw`), guard: "access",
    handler: async ({ request, env, access, params }) => {
      const session = await ituSession(env, access!);
      const b = await body(request);
      // A merged patch is already in the data repo: withdraw it with a revert PR. The submission
      // stays `merged` (202) until that PR's merge arrives; anything earlier closes the open PR.
      const cur = await getSub(env.DB, params[0]!);
      if (cur.state === "merged" || cur.state === "published") {
        const revert = await requestRevert(env.DB, session, cur.id, b, getPublisher(env));
        return json({ ok: true, submission: await getSub(env.DB, cur.id), revert }, 202);
      }
      return json({ ok: true, submission: await adminWithdraw(env.DB, session, cur.id, b, getPublisher(env)) });
    } },
];
