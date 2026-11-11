/**
 * The stub (and plain-http OIDC endpoints) may only ever be used on loopback
 * hosts. Allow-list (not a deny-list of ituob.org).
 */
export function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".localhost")
  );
}
