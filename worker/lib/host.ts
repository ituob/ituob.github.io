/**
 * The stub (and plain-http OIDC endpoints) may only ever be used on loopback
 * hosts. Allow-list (not a deny-list of ituob.org).
 */
export function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  );
}

/** Defence in depth: any of these present means a real deployment, so the local demo paths refuse even on a loopback URL. */
const PRODUCTION_MARKERS = [
  "ACCESS_AUD", "ACCESS_TEAM_DOMAIN", "ACCESS_CI_CLIENT_IDS", "ENVIRONMENT",
  "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_INSTALLATION_ID", "GITHUB_WEBHOOK_SECRET", "GITHUB_READ_TOKEN",
  "RESEND_API_KEY", "EMAIL_API_KEY",
];
export function hasProductionMarker(env: object): boolean {
  return PRODUCTION_MARKERS.some(key => (env as Record<string, unknown>)[key]);
}
