import { loadDatasetMetadata, loadListMetadata, loadRecommendationCatalog } from "./loaders";
import type { PublicationSource } from "./form/amendment-header";

/**
 * The recommendation and SP resource of a register, as the legacy editor read them from the publication record.
 * Recommendation: the register's code, its title and version from catalogs/recommendations.yaml (the version the
 * list metadata prints wins). SP url: the dataset or list metadata `url`; the recommendation page is not an SP resource.
 */
export function registerSource(registerId: string, slug: string, code: string | undefined): PublicationSource {
  const list = loadListMetadata(registerId), dataset = loadDatasetMetadata(slug);
  const recCode = code ?? list?.recommendation?.code ?? dataset?.recommendation?.code;
  const entry = recCode ? loadRecommendationCatalog().find(r => r.code === recCode) : undefined;
  const meta = list?.recommendation ?? dataset?.recommendation;
  const recommendation = recCode
    ? { body: meta?.body ?? entry?.bureau ?? "ITU-T", code: recCode, version: meta?.version ?? entry?.version, title: entry?.title?.en }
    : null;
  return { recommendation, url: list?.url || dataset?.url || null };
}
