/**
 * Per-register entry index for the citable entry pages.
 *
 * Emits every active entry with its replay key plus the per-key change
 * history, so /registers/{slug}/entries/{key}/ can render entirely
 * from this file without inlining entry data into thousands of pages.
 */
import type { APIRoute, GetStaticPaths } from "astro";
import {
  listSnapshotSlugs,
  loadManifest,
  loadCurrentState,
} from "~/lib/snapshots";

export const getStaticPaths: GetStaticPaths = () =>
  listSnapshotSlugs().map((slug) => ({ params: { slug } }));

export const GET: APIRoute = ({ params }) => {
  const slug = params.slug!;
  const manifest = loadManifest(slug);
  const state = loadCurrentState(slug);
  if (!manifest || !state) {
    return new Response(JSON.stringify({ slug, entries: [], history: {} }), {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  const keyField = manifest.key_field;
  const keyOf = (entry: Record<string, unknown>): string => {
    if (Array.isArray(keyField)) {
      return keyField.map((f) => (entry[f] == null ? "" : String(entry[f]))).join(" | ");
    }
    const v = entry[keyField];
    return v == null ? "" : String(v);
  };

  // The replay history records the identifier code per change; group
  // by code so an entry page can list every issue that touched it.
  const history: Record<string, { type: string; ob_issue: number | null }[]> = {};
  for (const h of state.history) {
    const code = (h.identifier as { code?: unknown } | null | undefined)?.code;
    if (code == null) continue;
    const list = history[String(code)] ?? [];
    list.push({ type: h.type, ob_issue: h.ob_issue });
    history[String(code)] = list;
  }

  const body = JSON.stringify({
    slug,
    key_field: keyField,
    at_issue: state.at_ob_issue,
    entries: state.active_entries.map((entry) => ({ key: keyOf(entry), entry })),
    history,
  });
  return new Response(body, {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
};
