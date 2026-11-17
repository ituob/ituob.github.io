// PDF adoption routes (ituob.github.io#106). Writes are Access-guarded; the
// approver allowlist (ADOPTION_APPROVERS) is checked server-side in adoption.ts.
import { adopt, liveAdoptions, parseInput, revoke } from "./lib/adoption.ts";
import { type Route, body, json } from "./lib/http.ts";
import { ituSession } from "./submission-routes.ts";

export const adoptionRoutes: Route[] = [
  { method: "GET", pattern: /^\/api\/publications\/adoptions$/, guard: "public",
    handler: async ({ env }) => json({ ok: true, adoptions: await liveAdoptions(env.DB) }) },
  { method: "POST", pattern: /^\/api\/admin\/publications\/adopt$/, guard: "access",
    handler: async ({ request, env, access }) => {
      const s = await ituSession(env, access!);
      const r = await adopt(env, s, access!.email, parseInput(await body(request)));
      return json({ ok: true, status: "itu-adopted", id: r.id }, 201);
    } },
  { method: "POST", pattern: /^\/api\/admin\/publications\/revoke$/, guard: "access",
    handler: async ({ request, env, access }) => {
      const s = await ituSession(env, access!);
      await revoke(env, s, access!.email, parseInput(await body(request)));
      return json({ ok: true, status: "candidate" });
    } },
];
