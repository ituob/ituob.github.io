import { approveGeneralMessage, createGeneralMessage, listGeneralMessages, readGeneralMessage, saveGeneralMessage } from "./lib/general-messages.ts";
import { type Route, body, json } from "./lib/http.ts";
import { ituSession } from "./submission-routes.ts";
const base = "/api/admin/general-messages";
const item = `${base}/([0-9A-HJKMNP-TV-Z]{26})`;
export const generalMessageRoutes: Route[] = [
  { method: "GET", pattern: new RegExp(`^${base}$`), guard: "access", handler: async ({env,access}) => json({ok:true,drafts:await listGeneralMessages(env.DB,await ituSession(env,access!))}) },
  { method: "POST", pattern: new RegExp(`^${base}$`), guard: "access", handler: async ({request,env,access}) => {
    const input=await body(request);
    return json({ok:true,draft:await createGeneralMessage(env.DB,await ituSession(env,access!),{ob_issue_no:input.ob_issue_no,type:input.type,value:input.value})});
  } },
  { method: "GET", pattern: new RegExp(`^${item}$`), guard: "access", handler: async ({env,access,params}) => json({ok:true,draft:await readGeneralMessage(env.DB,await ituSession(env,access!),params[0]!)}) },
  { method: "POST", pattern: new RegExp(`^${item}$`), guard: "access", handler: async ({request,env,access,params}) => {
    const input=await body(request);
    return json({ok:true,draft:await saveGeneralMessage(env.DB,await ituSession(env,access!),params[0]!,{expected_revision:input.expected_revision,value:input.value})});
  } },
  { method: "POST", pattern: new RegExp(`^${item}/approve$`), guard: "access", handler: async ({request,env,access,params}) => json({ok:true,draft:await approveGeneralMessage(env.DB,await ituSession(env,access!),params[0]!, (await body(request)).expected_revision)}) },
];
