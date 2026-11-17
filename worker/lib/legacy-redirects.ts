import redirects from "./legacy-redirects.json";

// Keys are literal production filenames, normalized only for HTML aliases.
// Decode once: encoded spaces/parentheses are aliases, encoded path separators
// are not. Unknown and malformed URLs continue through normal asset handling.
export function legacyRedirectTarget(pathname: string): string | null {
  if (/%2f|%5c/i.test(pathname)) return null;
  let path: string;
  try { path = decodeURIComponent(pathname); } catch { return null; }
  path = path.replace(/\/index\.html$/, "/");
  if (!path.endsWith("/")) path += "/";
  return (redirects as Record<string, string>)[path] ?? null;
}
