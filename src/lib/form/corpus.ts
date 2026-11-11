/**
 * Which class owns a stored corpus file. Port of Ituob::Support::CorpusTree
 * (service-publications-docs ituob/lib/ituob/support/corpus_tree.rb), with
 * general messages resolved by their stored `type` where the Ruby map is
 * coarser (sanc -> GeneralMessage there, GeneralSancs here).
 *
 *   ob-issues/<issue>/meta.yaml                       IssueMetadata
 *   ob-issues/<issue>/general/running_annexes.yaml    GeneralRunningAnnexes
 *   ob-issues/<issue>/general/approved_recommendations.yaml  GeneralApprovedRecommendations
 *   ob-issues/<issue>/<message dir>/NNN.yaml          General* by `type`
 *   ob-issues/<issue>/<register slug>/NNN-ACT.yaml    RegisterChange (envelope; data is the <X>Amendment)
 *   ob-issues/<issue>/<slug>/text.yaml                TextAmendment
 *
 * annexes.yaml and other general/* files are freeform and not form-driven.
 */
export const REGISTER_SLUGS = [
  "dp", "e118-iin", "e164-acn", "e164-cc", "e212-mnc", "e218-trcc", "f32-tdi", "f400-admd", "list-viii",
  "m1400-icc", "nnp", "q708-ispc", "q708-sanc", "t35-na", "x121-dnic",
] as const;

const GENERAL_BY_TYPE: Record<string, string> = {
  approved_recommendations: "GeneralApprovedRecommendations",
  callback_procedures: "GeneralCallbackProcedures",
  custom: "GeneralCustom",
  ipns: "GeneralIpns",
  iptn: "GeneralIptn",
  mid: "GeneralMid",
  misc_communications: "GeneralMiscCommunications",
  org_changes: "GeneralOrgChanges",
  running_annexes: "GeneralRunningAnnexes",
  sanc: "GeneralSancs",
  service_restrictions: "GeneralServiceRestrictions",
  telephone_service: "GeneralTelephoneServices",
  telephone_service_2: "GeneralTelephoneService",
};

const GENERAL_DIRS = new Set([
  "callback_procedures", "custom", "ipns", "iptn", "mid", "misc_communications", "org_changes", "sanc",
  "service_restrictions", "telephone_service", "telephone_service_2",
]);

export type Role = "metadata" | "general" | "register-change" | "text-amendment";

export interface Classified {
  className: string;
  role: Role;
}

/** null = not a form-driven file (freeform annex snapshot, general prose). */
export function classify(rel: string, data: unknown): Classified | null {
  if (rel === "meta.yaml") return { className: "IssueMetadata", role: "metadata" };
  if (rel === "annexes.yaml") return null;
  if (rel === "general/running_annexes.yaml") return { className: "GeneralRunningAnnexes", role: "general" };
  if (rel === "general/approved_recommendations.yaml") return { className: "GeneralApprovedRecommendations", role: "general" };
  const m = /^([^/]+)\/([^/]+)\.yaml$/.exec(rel);
  if (!m) return null;
  const [, slug = "", stem = ""] = m;
  if (stem === "text") return { className: "TextAmendment", role: "text-amendment" };
  if ((REGISTER_SLUGS as readonly string[]).includes(slug)) {
    return /^\d[\w.-]*$/.test(stem) ? { className: "RegisterChange", role: "register-change" } : null;
  }
  if (GENERAL_DIRS.has(slug)) {
    const type = (data as { type?: unknown } | null)?.type;
    const className = typeof type === "string" ? GENERAL_BY_TYPE[type] : undefined;
    return className ? { className, role: "general" } : null;
  }
  return null;
}
