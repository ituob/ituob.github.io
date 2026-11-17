import { InvalidError } from "./membership.ts";

/** Shared identifier parsing does not grant access to composer mutations. */
export function editionNo(v: unknown): number {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 99999) throw new InvalidError("ob_issue_no must be a positive integer");
  return n;
}
