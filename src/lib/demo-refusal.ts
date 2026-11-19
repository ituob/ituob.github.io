/**
 * LOCAL DEMO ONLY (PUBLIC_LOCAL_DEMO=1, set by scripts/dev-local.mjs for the Astro dev server only).
 * A bare 403 says nothing about why. In the demo, name the persona's actual situation so a refusal
 * reads as the right refusal. Production builds never set the flag and keep the generic messages.
 */
interface Who { authenticated?: boolean; user?: { displayName?: string | null }; roles?: string[] }
interface Membership { kind: string; status: string }

export const demoMode = (): boolean => import.meta.env.PUBLIC_LOCAL_DEMO === '1';

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
    if (response.ok) return await response.json() as T;
    // An unread body keeps the request open in the browser, so a refusal drops it.
    await response.body?.cancel().catch(() => undefined);
    return null;
  } catch { return null; }
}

export async function explainRefusal(path: string): Promise<string | null> {
  if (!demoMode()) return null;
  const who = await getJson<Who>('/api/whoami');
  if (!who?.authenticated) return 'Sign in to continue.';
  const roles = who.roles ?? [];
  const name = who.user?.displayName ?? 'This account';
  if (path.startsWith('/api/admin/')) {
    if (roles.some(role => role === 'itu-admin' || role === 'itu-editor')) return 'This action needs the ITU administrator role; your ITU editor role can review but not perform it.';
    return `This page is for ITU staff. ${name} is not ITU staff, so administration is not available.`;
  }
  if (roles.length > 0) return 'You do not have permission for this action.';
  const memberships = (await getJson<{ memberships: Membership[] }>('/api/me/membership'))?.memberships ?? [];
  if (memberships.some(m => m.kind === 'member' && m.status === 'active')) return `${name} belongs to a Member State whose membership is suspended, so submitting and viewing proposals is switched off. Contact ITU to restore it.`;
  if (memberships.some(m => m.status === 'pending')) return 'Your membership claim is waiting for ITU verification. Submissions open once it is verified.';
  return 'Submitting proposals needs a verified Member State membership. Claim one on the Membership page.';
}
