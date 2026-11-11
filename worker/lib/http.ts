import { InvalidError } from "./membership.ts";
import type { AccessIdentity, Env, Session } from "./types.ts";

export type Guard = "public" | "session" | "access";
export interface Ctx {
  request: Request;
  env: Env;
  url: URL;
  params: string[];
  session: Session | null;
  access: AccessIdentity | null;
}
export type Handler = (c: Ctx) => Promise<Response>;
export interface Route {
  method: string;
  pattern: RegExp;
  guard: Guard;
  handler: Handler;
}

export const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", Vary: "Cookie" } });

export async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const b = await request.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    throw new InvalidError("body must be a JSON object");
  }
}
export const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
