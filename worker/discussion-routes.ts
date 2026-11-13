// Discussion + notification routes (#104). Member side under session-guarded
// /api/me/*; moderation and ITU equivalents under Access-guarded /api/admin/*.
import {
  addComment, addParticipant, deleteComment, editComment, listNotifications, markRead, readHistory,
  readThread, restoreComment, setDiscussionClosed, setHandle, setPrefs,
} from "./lib/discussion.ts";
import { type Route, body, json } from "./lib/http.ts";
import { ituSession } from "./submission-routes.ts";

const ID = "([0-9A-Z]{26})";
const re = (s: string) => new RegExp(`^${s}$`);
const me = `/api/me/submissions/${ID}`;
const adm = `/api/admin/submissions/${ID}`;
const optBody = (r: Request) => body(r).catch(() => ({}));

export const discussionRoutes: Route[] = [
  { method: "GET", pattern: re(`${me}/comments`), guard: "session",
    handler: async ({ env, session, params }) => json({ ok: true, ...(await readThread(env.DB, session, params[0]!)) }) },
  { method: "POST", pattern: re(`${me}/comments`), guard: "session",
    handler: async ({ request, env, session, params }) => json({ ok: true, comment: await addComment(env.DB, session, params[0]!, await body(request)) }, 201) },
  { method: "PUT", pattern: re(`${me}/comments/${ID}`), guard: "session",
    handler: async ({ request, env, session, params }) => json({ ok: true, comment: await editComment(env.DB, session, params[0]!, params[1]!, await body(request)) }) },
  { method: "DELETE", pattern: re(`${me}/comments/${ID}`), guard: "session",
    handler: async ({ request, env, session, params }) => json({ ok: true, comment: await deleteComment(env.DB, session, params[0]!, params[1]!, await optBody(request), false) }) },
  { method: "GET", pattern: re(`${me}/history`), guard: "session",
    handler: async ({ env, session, params }) => json({ ok: true, ...(await readHistory(env.DB, session, params[0]!)) }) },

  { method: "GET", pattern: /^\/api\/me\/notifications$/, guard: "session",
    handler: async ({ env, session, url }) => json({ ok: true, notifications: await listNotifications(env.DB, session, url.searchParams.get("unread") === "1") }) },
  { method: "POST", pattern: /^\/api\/me\/notifications\/([0-9A-Z]{26})\/read$/, guard: "session",
    handler: async ({ env, session, params }) => { await markRead(env.DB, session, params[0]!); return json({ ok: true }); } },
  { method: "PUT", pattern: /^\/api\/me\/notification-prefs$/, guard: "session",
    handler: async ({ request, env, session }) => json({ ok: true, ...(await setPrefs(env.DB, session, (await body(request)).level)) }) },
  { method: "GET", pattern: /^\/api\/me\/notification-prefs$/, guard: "session",
    handler: async ({ env, session }) => {
      const row = await env.DB.prepare("SELECT level FROM notification_prefs WHERE user_id=?1").bind(session!.userId).first<{ level: string }>();
      return json({ ok: true, level: row?.level ?? "all" });
    } },
  { method: "PUT", pattern: /^\/api\/me\/handle$/, guard: "session",
    handler: async ({ request, env, session }) => json({ ok: true, ...(await setHandle(env.DB, session, (await body(request)).handle)) }) },
  { method: "GET", pattern: /^\/api\/me\/handle$/, guard: "session",
    handler: async ({ env, session }) => {
      const row = await env.DB.prepare("SELECT handle FROM user_handles WHERE user_id=?1").bind(session!.userId).first<{ handle: string }>();
      return json({ ok: true, handle: row?.handle ?? null });
    } },

  // ITU equivalents (the role check is repeated server-side by ituSession).
  { method: "GET", pattern: re(`${adm}/comments`), guard: "access",
    handler: async ({ env, access, params }) => json({ ok: true, ...(await readThread(env.DB, await ituSession(env, access!), params[0]!)) }) },
  { method: "POST", pattern: re(`${adm}/comments`), guard: "access",
    handler: async ({ request, env, access, params }) => json({ ok: true, comment: await addComment(env.DB, await ituSession(env, access!), params[0]!, await body(request)) }, 201) },
  { method: "PUT", pattern: re(`${adm}/comments/${ID}`), guard: "access",
    handler: async ({ request, env, access, params }) => json({ ok: true, comment: await editComment(env.DB, await ituSession(env, access!), params[0]!, params[1]!, await body(request)) }) },
  { method: "DELETE", pattern: re(`${adm}/comments/${ID}`), guard: "access",
    handler: async ({ request, env, access, params }) => json({ ok: true, comment: await deleteComment(env.DB, await ituSession(env, access!), params[0]!, params[1]!, await optBody(request), true) }) },
  { method: "POST", pattern: re(`${adm}/comments/${ID}/restore`), guard: "access",
    handler: async ({ request, env, access, params }) => json({ ok: true, comment: await restoreComment(env.DB, await ituSession(env, access!), params[0]!, params[1]!, await body(request)) }) },
  { method: "GET", pattern: re(`${adm}/history`), guard: "access",
    handler: async ({ env, access, params }) => json({ ok: true, ...(await readHistory(env.DB, await ituSession(env, access!), params[0]!)) }) },
  { method: "POST", pattern: re(`${adm}/discussion/close`), guard: "access",
    handler: async ({ request, env, access, params }) => json({ ok: true, ...(await setDiscussionClosed(env.DB, await ituSession(env, access!), params[0]!, true, await body(request))) }) },
  { method: "POST", pattern: re(`${adm}/discussion/reopen`), guard: "access",
    handler: async ({ request, env, access, params }) => json({ ok: true, ...(await setDiscussionClosed(env.DB, await ituSession(env, access!), params[0]!, false, await body(request))) }) },
  { method: "POST", pattern: re(`${adm}/participants`), guard: "access",
    handler: async ({ request, env, access, params }) => json({ ok: true, ...(await addParticipant(env.DB, await ituSession(env, access!), params[0]!, await body(request))) }, 201) },
];
