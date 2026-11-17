import scopes from "./legacy-archive-scopes.json";

/** Membership comes from article source links in production commit
 * 8ef2eb431183bdb1257c632d340ee3476169a265. Edition dates are labels, not
 * boundaries: the legacy archives distinguish UTC and printed-date editions.
 */
export interface LegacyArchiveScope {
  kind: string;
  code?: string;
  slug?: string;
  publication?: string;
  edition?: string;
  editionToken?: string;
  year?: number;
  old_url: string;
  new_route: string;
  issueIds: number[];
}

export const legacyArchiveScopes: LegacyArchiveScope[] = scopes;
