import {
  ConflictError,
  InvalidError,
  NotFoundError,
  claimMembership,
  deactivateMembership,
  importRoster,
  listClaims,
  provisionItuStaff,
  rejectClaim,
  setMemberStatus,
  verifyClaim,
  type RosterRow,
} from "./lib/membership.ts";
import { Forbidden } from "./lib/authz.ts";
import { sameOrigin } from "./lib/csrf.ts";
import { StubMisconfigured, getAccessIdentity, getSession, takePendingSessionCookie } from "./lib/session.ts";
import { type Route, body, json, str } from "./lib/http.ts";
import { UpstreamError, ValidationFailed } from "./lib/submissions.ts";
import { discussionRoutes } from "./discussion-routes.ts";
import { composerRoutes } from "./composer-routes.ts";
import { submissionRoutes } from "./submission-routes.ts";
import { webhookRoutes } from "./webhook-routes.ts";
import type { AccessIdentity, Env, Session } from "./lib/types.ts";

const routes: Route[] = [
  ...submissionRoutes,
  ...composerRoutes,
  ...discussionRoutes,
  ...webhookRoutes,
  {
    method: "GET",
    pattern: /^\/api\/whoami$/,
    guard: "public",
    handler: async ({ env, session }) => {
      if (!session) return json({ ok: true, authenticated: false });
      const u = await env.DB.prepare(`SELECT email, display_name FROM users WHERE id = ?1`)
        .bind(session.userId)
        .first<{ email: string | null; display_name: string | null }>();
      return json({
        ok: true,
        authenticated: true,
        userId: session.userId,
        user: { id: session.userId, displayName: u?.display_name ?? null, email: u?.email ?? null },
        roles: session.roles,
        memberStateId: session.memberStateId,
      });
    },
  },
  // Member action, session-guarded. Reads ONLY memberId and note: a status,
  // role or user id in the body is ignored by construction.
  {
    method: "POST",
    pattern: /^\/api\/me\/membership\/claim$/,
    guard: "session",
    handler: async ({ request, env, session }) => {
      const b = await body(request);
      const memberId = str(b.memberId);
      if (!memberId) throw new InvalidError("memberId required");
      const id = await claimMembership(env.DB, session!.userId, memberId, str(b.note));
      return json({ ok: true, membershipId: id, status: "pending" }, 201);
    },
  },
  // ITU admin surface, Access-guarded.
  {
    method: "GET",
    pattern: /^\/api\/admin\/claims$/,
    guard: "access",
    handler: async ({ env, url }) =>
      json({ ok: true, claims: await listClaims(env.DB, url.searchParams.get("status") ?? "pending") }),
  },
  {
    method: "POST",
    pattern: /^\/api\/admin\/claims\/(\d+)\/verify$/,
    guard: "access",
    handler: async ({ request, env, params, access }) => {
      await verifyClaim(env.DB, Number(params[0]), access!.email, str((await body(request)).note));
      return json({ ok: true, status: "active" });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/admin\/claims\/(\d+)\/reject$/,
    guard: "access",
    handler: async ({ request, env, params, access }) => {
      await rejectClaim(env.DB, Number(params[0]), access!.email, str((await body(request)).note));
      return json({ ok: true, status: "rejected" });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/admin\/memberships\/(\d+)\/deactivate$/,
    guard: "access",
    handler: async ({ request, env, params, access }) => {
      await deactivateMembership(env.DB, Number(params[0]), access!.email, str((await body(request)).note));
      return json({ ok: true, status: "deactivated" });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/admin\/itu-staff$/,
    guard: "access",
    handler: async ({ request, env, access }) => {
      const b = await body(request);
      const userId = str(b.userId);
      if (!userId || !Array.isArray(b.roles)) throw new InvalidError("userId and roles required");
      const id = await provisionItuStaff(env.DB, userId, b.roles.map(String), access!.email);
      return json({ ok: true, membershipId: id }, 201);
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/admin\/members\/([^/]+)\/status$/,
    guard: "access",
    handler: async ({ request, env, params, access }) => {
      await setMemberStatus(env.DB, decodeURIComponent(params[0]!), String((await body(request)).status), access!.email);
      return json({ ok: true });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/admin\/roster\/import$/,
    guard: "access",
    handler: async ({ request, env, url, access }) => {
      const b = await body(request);
      if (!Array.isArray(b.members)) throw new InvalidError("members array required");
      const dry = url.searchParams.get("dry_run") === "1";
      return json({ ok: true, ...(await importRoster(env.DB, b.members as RosterRow[], dry, access!.email)) });
    },
  },
];

/** Paths whose trust path is Access, even for GET. Unknown paths here still require Access. */
const ACCESS_PREFIXES = ["/api/admin/", "/api/ci/"];

/** Attach a rotated session cookie (set by getSession) to the response. */
function withRotation(request: Request, res: Response): Response {
  const cookie = takePendingSessionCookie(request);
  if (!cookie) return res;
  const h = new Headers(res.headers);
  h.append("Set-Cookie", cookie);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

export async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  return withRotation(request, await handleApiInner(request, env, url));
}

async function handleApiInner(request: Request, env: Env, url: URL): Promise<Response> {
  try {
    const path = url.pathname;
    const method = request.method.toUpperCase();
    const readOnly = method === "GET" || method === "HEAD";

    if (path === "/api/health" && readOnly) {
      return Response.json({ ok: true, service: "ituob-org", version: "phase-1" });
    }

    const route = routes.find((r) => r.method === method && r.pattern.test(path));
    const onAccessPrefix = ACCESS_PREFIXES.some((p) => path.startsWith(p));

    // Deny by default: no route, and not a read, is refused outright.
    if (!route && !readOnly) return json({ error: "forbidden" }, 403);

    if (route?.guard === "access" || (!route && onAccessPrefix)) {
      // A session cookie/stub-session is never consulted on Access routes.
      const access = await getAccessIdentity(request, env);
      if (!access) return json({ error: "forbidden" }, 403);
      if (!route) return json({ error: "not found" }, 404);
      return await route.handler({ request, env, url, params: path.match(route.pattern)!.slice(1), session: null, access });
    }
    if (!route) return json({ error: "not found" }, 404);

    // An Access identity is never consulted on session routes.
    const session = await getSession(request, env);
    if (route.guard === "session") {
      if (!session) return json({ error: "unauthenticated" }, 401);
      if (!sameOrigin(request)) return json({ error: "forbidden" }, 403);
    }
    return await route.handler({ request, env, url, params: path.match(route.pattern)!.slice(1), session, access: null });
  } catch (e) {
    if (e instanceof Forbidden) return json({ error: "forbidden" }, 403);
    if (e instanceof NotFoundError) return json({ error: e.message }, 404);
    if (e instanceof ConflictError) return json({ error: e.message }, 409);
    if (e instanceof ValidationFailed) return json({ error: "validation failed", errors: e.errors }, 422);
    if (e instanceof UpstreamError) return json({ error: e.message }, 502);
    if (e instanceof InvalidError) return json({ error: e.message }, 400);
    if (e instanceof StubMisconfigured) return json({ error: "server misconfigured" }, 500);
    throw e;
  }
}
