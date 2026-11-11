/** Same-origin check for state-changing requests (SameSite=Lax is the first layer). */
export function sameOrigin(request: Request): boolean {
  const site = request.headers.get("Sec-Fetch-Site");
  if (site) return site === "same-origin" || site === "none";
  const origin = request.headers.get("Origin");
  return !!origin && origin === new URL(request.url).origin;
}
