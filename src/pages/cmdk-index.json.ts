import type { APIRoute } from "astro";
import { listIssueIds, loadIssue, listDatasetSlugs, loadDatasetMetadata, loadRegisterCatalog, loadRecommendationCatalog } from "~/lib/loaders";
import { PUBLICATION_BY_SLUG } from "~/lib/catalogs";
import { slugifyRecCode } from "~/lib/format";

interface CmdkEntry {
  kind: "issue" | "register" | "dataset" | "recommendation" | "page";
  label: string;
  href: string;
  meta?: string;
  boost?: number;
}

export const GET: APIRoute = () => {
  const entries: CmdkEntry[] = [];

  for (const id of listIssueIds()) {
    const issue = loadIssue(id);
    if (!issue) continue;
    entries.push({
      kind: "issue",
      label: `OB No. ${id}`,
      href: `/issues/${id}/`,
      meta: issue.meta.publication_date,
      boost: 50 + Math.min(50, id),
    });
  }

  for (const slug of listDatasetSlugs()) {
    const meta = loadDatasetMetadata(slug);
    const known = PUBLICATION_BY_SLUG.get(slug);
    const title = meta?.title?.en ?? known?.label ?? slug;
    entries.push({
      kind: "dataset",
      label: title,
      href: `/datasets/${slug}/`,
      meta: slug,
    });
  }

  for (const reg of loadRegisterCatalog()) {
    const title = reg.title?.en ?? reg.register_id;
    entries.push({
      kind: "register",
      label: title,
      href: `/registers/${reg.slug}/`,
      meta: reg.recommendation,
    });
  }

  for (const rec of loadRecommendationCatalog()) {
    entries.push({
      kind: "recommendation",
      label: `ITU-T ${rec.code}`,
      href: `/recommendations/${slugifyRecCode(rec.code)}/`,
      meta: rec.title?.en?.slice(0, 40),
    });
  }

  const pages: CmdkEntry[] = [
    { kind: "page", label: "Homepage", href: "/", boost: 100 },
    { kind: "page", label: "Issue archive", href: "/issues/", boost: 80 },
    { kind: "page", label: "Datasets", href: "/datasets/", boost: 70 },
    { kind: "page", label: "Registers", href: "/registers/", boost: 70 },
    { kind: "page", label: "Recommendations", href: "/recommendations/", boost: 60 },
    { kind: "page", label: "Message types", href: "/types/", boost: 50 },
    { kind: "page", label: "About", href: "/about/", boost: 30 },
  ];
  entries.push(...pages);

  return new Response(JSON.stringify(entries), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    },
  });
};
