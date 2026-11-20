import { explainRefusal } from "../../lib/demo-refusal";

export interface Identity {
  authenticated: boolean;
  userId?: string;
  user?: { id: string; email: string | null; displayName: string | null };
  roles?: string[];
  memberStateId?: string | null;
  access?: { email: string } | null;
}
export interface Member { id: string; name: string; status?: string }
export interface Membership {
  id: number; kind: string; member_id: string | null; status: string;
  claim_note?: string | null; decision_note?: string | null; claimed_at?: string;
}
export class NotAvailableYet extends Error {}
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  // An unread body keeps the request open in the browser (it never finishes), so refusals drop it first.
  if (response.status === 401 || response.status === 403 || !response.headers.get("Content-Type")?.includes("application/json")) await response.body?.cancel().catch(() => undefined);
  if (response.status === 401) throw new Error("Your session has ended. Sign in again to continue.");
  if (response.status === 403) throw new Error((await explainRefusal(path)) ?? "You do not have permission for this action. Administration requires Cloudflare Access sign-in.");
  if (!response.headers.get("Content-Type")?.includes("application/json")) throw new Error("The service could not complete this request. Please try again.");
  const data = await response.json();
  if (data?.code === "not_available_yet") throw new NotAvailableYet(data.error);
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "The request failed. Please try again.");
  return data as T;
}
