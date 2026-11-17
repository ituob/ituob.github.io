import type { APIRoute } from 'astro';
import { listSnapshotSlugs, loadCurrentState } from '../../../lib/snapshots';

/** Current replayed rows of a register: the baseline the bulk importer diffs against. Public register data. */
export function getStaticPaths() { return listSnapshotSlugs().map(slug => ({ params: { slug } })); }
export const GET: APIRoute = ({ params }) =>
  new Response(JSON.stringify({ slug: params.slug, entries: loadCurrentState(params.slug!)?.active_entries ?? [] }), { headers: { 'Content-Type': 'application/json' } });
