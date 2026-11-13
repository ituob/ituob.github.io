// Machine-translation assist route (#101). ITU staff only: Access identity + ituSession +
// itu-admin/itu-editor role, same-origin enforced by handleApi for non-GET Access routes.
import { Forbidden, requireRole } from "./lib/authz.ts";
import { type Route, body, json } from "./lib/http.ts";
import { parseRequest, translate } from "./lib/translation.ts";
import { ituSession } from "./submission-routes.ts";

export const translationRoutes: Route[] = [
  { method: "POST", pattern: /^\/api\/admin\/translate$/, guard: "access",
    handler: async ({ request, env, access }) => {
      if (!access) throw new Forbidden();
      requireRole(await ituSession(env, access), "itu-admin", "itu-editor");
      const req = parseRequest(await body(request));
      const text = await translate(req);
      return json({ ok: true, provider: "nmt.itu.int", from: req.from, to: req.to, text });
    } },
];
