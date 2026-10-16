/**
 * Canonical catalogs for the ITU Operational Bulletin domain.
 *
 * Mirrors ituob/lib/ituob/catalogs/{message_types,action_types,publications}.rb.
 * Single source of truth for: which message types exist, which actions exist,
 * and how publication IDs map to filesystem slugs.
 *
 * Keep this file in sync with the Ruby gem when the gem changes.
 */

/** General message type — a category of message in the GENERAL INFORMATION
 * section of an OB issue. */
export type GeneralMessageType =
  | "running_annexes"
  | "approved_recommendations"
  | "sanc"
  | "iptn"
  | "ipns"
  | "mid"
  | "org_changes"
  | "misc_communications"
  | "service_restrictions"
  | "custom"
  | "callback_procedures"
  | "telephone_service"
  | "telephone_service_2"
  | "no_type";

export const STRUCTURED_GENERAL_TYPES: readonly GeneralMessageType[] = [
  "running_annexes",
  "approved_recommendations",
] as const;

export const TEXTUAL_GENERAL_TYPES: readonly GeneralMessageType[] = [
  "sanc",
  "iptn",
  "ipns",
  "mid",
  "org_changes",
  "misc_communications",
  "service_restrictions",
  "custom",
  "callback_procedures",
  "telephone_service",
  "telephone_service_2",
  "no_type",
] as const;

export const ALL_GENERAL_TYPES: readonly GeneralMessageType[] = [
  ...STRUCTURED_GENERAL_TYPES,
  ...TEXTUAL_GENERAL_TYPES,
] as const;

/** Action type — the kind of change an Amendment applies. */
export type ActionType = "ADD" | "SUP" | "REP" | "LIR" | "MOD" | "DEL";

export const ALL_ACTION_TYPES: readonly ActionType[] = [
  "ADD",
  "SUP",
  "REP",
  "LIR",
  "MOD",
  "DEL",
] as const;

/** Human description of each action type (English). */
export const ACTION_TYPE_LABELS: Record<ActionType, string> = {
  ADD: "Addition",
  SUP: "Suppression",
  REP: "Replacement",
  LIR: "Lapsed / Inactive Record",
  MOD: "Modification",
  DEL: "Deletion",
};

/** Publication classification. */
export type PublicationClassification = "structured" | "textual";

export interface PublicationEntry {
  publicationId: string;
  slug: string;
  classification: PublicationClassification;
  /** Human-readable short label (English). */
  label: string;
  /** Optional recommendation reference, e.g. "M.1400". */
  recommendation?: string;
}

/**
 * The publication registry. Open for extension: add new entries here only.
 * Slug MUST match the directory name under ob-issues/{issue}/{slug}/ and
 * datasets/{slug}/.
 */
export const PUBLICATIONS: readonly PublicationEntry[] = [
  // Structured
  {
    publicationId: "E118_IIN",
    slug: "e118-iin",
    classification: "structured",
    label: "List of Issuer Identification Numbers (E.118 IIN)",
    recommendation: "E.118",
  },
  {
    publicationId: "DP",
    slug: "dp",
    classification: "structured",
    label: "Destination Points",
    recommendation: "E.164",
  },
  {
    publicationId: "E164_ACN",
    slug: "e164-acn",
    classification: "structured",
    label: "E.164 Assigned Country Numbers",
    recommendation: "E.164",
  },
  {
    publicationId: "E164_CC",
    slug: "e164-cc",
    classification: "structured",
    label: "E.164 Country Codes",
    recommendation: "E.164",
  },
  {
    publicationId: "E212_MNC",
    slug: "e212-mnc",
    classification: "structured",
    label: "List of Mobile Network Codes (E.212 MNC)",
    recommendation: "E.212",
  },
  {
    publicationId: "E218_TRCC",
    slug: "e218-trcc",
    classification: "structured",
    label: "List of Telecommunication Routing Codes (E.218 TRCC)",
    recommendation: "E.218",
  },
  {
    publicationId: "F32_TDI",
    slug: "f32-tdi",
    classification: "structured",
    label: "Telegram Destination Indicators (F.32 TDI)",
    recommendation: "F.32",
  },
  {
    publicationId: "F400_ADMD",
    slug: "f400-admd",
    classification: "structured",
    label: "Administration Management Domains (F.400 ADMD)",
    recommendation: "F.400",
  },
  {
    publicationId: "M1400_ICC",
    slug: "m1400-icc",
    classification: "structured",
    label: "List of ITU Carrier Codes (M.1400 ICC)",
    recommendation: "M.1400",
  },
  {
    publicationId: "Q708_ISPC",
    slug: "q708-ispc",
    classification: "structured",
    label: "International Signalling Point Codes (Q.708 ISPC)",
    recommendation: "Q.708",
  },
  {
    publicationId: "Q708_SANC",
    slug: "q708-sanc",
    classification: "structured",
    label: "Signalling Area/Network Codes (Q.708 SANC)",
    recommendation: "Q.708",
  },
  {
    publicationId: "T35_NA",
    slug: "t35-na",
    classification: "structured",
    label: "Network Addresses (T.35 NA)",
    recommendation: "T.35",
  },
  {
    publicationId: "X121_DNIC",
    slug: "x121-dnic",
    classification: "structured",
    label: "Data Network Identification Codes (X.121 DNIC)",
    recommendation: "X.121",
  },

  // Textual
  {
    publicationId: "RR.25.1",
    slug: "rr251",
    classification: "textual",
    label: "RR.25.1 — List of Ship and Coast Station Call Signs",
  },
  {
    publicationId: "BUREAUFAX",
    slug: "bureaufax",
    classification: "textual",
    label: "Bureaufax Service",
  },
  {
    publicationId: "List of Coast Stations and Special Service Stations",
    slug: "coast-stations",
    classification: "textual",
    label: "List of Coast Stations and Special Service Stations",
  },
  {
    publicationId: "R_SP_LM.V",
    slug: "list-v",
    classification: "textual",
    label: "List V — List of Ship and Coast Stations (RR Appendix 25)",
  },
  {
    publicationId: "R_SP_LN.VIII",
    slug: "list-viii",
    classification: "textual",
    label: "List VIII — List of Coast Stations and Special Service Stations",
  },
  {
    publicationId: "NNP",
    slug: "nnp",
    classification: "textual",
    label: "National Numbering Plans (E.129 NNP)",
    recommendation: "E.129",
  },
  {
    publicationId: "E212_ICC",
    slug: "e212-icc",
    classification: "textual",
    label: "E.212 ITU Carrier Codes (textual)",
    recommendation: "E.212",
  },
] as const;

export const PUBLICATION_BY_ID: ReadonlyMap<string, PublicationEntry> = new Map(
  PUBLICATIONS.map((p) => [p.publicationId, p]),
);

export const PUBLICATION_BY_SLUG: ReadonlyMap<string, PublicationEntry> = new Map(
  PUBLICATIONS.map((p) => [p.slug, p]),
);

/** Default slug derivation when a publication ID is not registered. */
export function slugForPublicationId(publicationId: string): string {
  const known = PUBLICATION_BY_ID.get(publicationId);
  if (known) return known.slug;
  return publicationId
    .toLowerCase()
    .replace(/\./g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

/** Display labels for textual general message types. */
export const GENERAL_TYPE_LABELS: Record<GeneralMessageType, string> = {
  running_annexes: "Lists annexed to the ITU Operational Bulletin",
  approved_recommendations: "Approval of ITU-T Recommendations",
  sanc: "Assignment of Signalling Area/Network Codes (SANC)",
  iptn: "The International Public Telecommunication Numbering Plan",
  ipns:
    "International Identification Plan for Public Networks and Subscriptions",
  mid: "Maritime Identification Digits (MID)",
  org_changes: "Changes in Administrations/ROAs and other entities or Organizations",
  misc_communications: "Other communications",
  service_restrictions: "Service Restrictions",
  custom: "Custom Communications",
  callback_procedures:
    "Call-back and alternative calling procedures (Res. 21 Rev. PP-2006)",
  telephone_service: "Telephone Service",
  telephone_service_2: "Telephone Service",
  no_type: "Other Communications",
};

/** Per-type metadata: recommendation reference, online URL. */
export interface MessageRecommendation {
  body?: string;
  code?: string;
  version?: string;
}

export interface MessageTypeMetadata {
  recommendation?: MessageRecommendation;
  url?: string;
}

export const MESSAGE_TYPE_METADATA: Record<GeneralMessageType, MessageTypeMetadata> = {
  running_annexes: {},
  approved_recommendations: {},
  sanc: { recommendation: { body: "ITU-T", code: "Q.708", version: "1999-03" } },
  iptn: { recommendation: { body: "ITU-T", code: "E.164", version: "2010-11" } },
  ipns: { recommendation: { body: "ITU-T", code: "E.212", version: "2016-09" } },
  mid: {},
  org_changes: {},
  misc_communications: {},
  service_restrictions: { url: "http://www.itu.int/pub/T-SP-SR.1-2012" },
  custom: {},
  callback_procedures: { url: "http://www.itu.int/pub/T-SP-PP.RES.21-2011/" },
  telephone_service: {
    recommendation: { body: "ITU-T", code: "E.164" },
    url: "http://www.itu.int/itu-t/inr-nnp",
  },
  telephone_service_2: {
    recommendation: { body: "ITU-T", code: "E.164" },
    url: "http://www.itu.int/itu-t/inr-nnp",
  },
  no_type: {},
};

/** Canonical ordering of message types within an issue page. */
export const MESSAGE_TYPE_ORDER: readonly GeneralMessageType[] = [
  "running_annexes",
  "approved_recommendations",
  "sanc",
  "iptn",
  "ipns",
  "mid",
  "org_changes",
  "service_restrictions",
  "callback_procedures",
  "telephone_service",
  "telephone_service_2",
  "misc_communications",
  "custom",
  "no_type",
] as const;

/** Default rendering language. */
export const DEFAULT_LANGUAGE = "en" as const;
export const SUPPORTED_LANGUAGES = ["en", "fr", "es", "ru", "zh", "ar"] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

/**
 * Reverse index: for each recommendation code, which general message types
 * are linked to it. Used by the recommendation page to surface every general
 * message across every issue that's semantically tied to the rec.
 *
 * Mirrors the deployed Jekyll `complement-to-itu-t-r {code}` page which
 * aggregates e.g. all telephone_service_2 messages under E.164, all ipns
 * messages under E.212, all sanc messages under Q.708.
 */
export const RECOMMENDATION_GENERAL_TYPES: ReadonlyMap<string, readonly GeneralMessageType[]> = (() => {
  const map = new Map<string, GeneralMessageType[]>();
  for (const t of ALL_GENERAL_TYPES) {
    const code = MESSAGE_TYPE_METADATA[t]?.recommendation?.code;
    if (!code) continue;
    const arr = map.get(code) ?? [];
    arr.push(t);
    map.set(code, arr);
  }
  return map;
})();

/** Look up the general message types linked to a recommendation code. */
export function generalTypesForRec(code: string): readonly GeneralMessageType[] {
  return RECOMMENDATION_GENERAL_TYPES.get(code) ?? [];
}

/** ISSN (immutable across all issues). */
export const OB_ISSN = "1564-5223";
