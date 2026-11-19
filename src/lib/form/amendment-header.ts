import { clearField, setField, type FormNode } from "./model";
import { YamlTimestamp } from "./yaml-io";
import { runningAnnexes, zurichPositionDay, type AnnexIndexEntry } from "./annexes";

/**
 * The amendment header of the legacy editor (message-forms/amendment.tsx AmendmentMeta):
 * "Amending position of DATE annexed to OB n", or a warning when the publication has no
 * annexed position. An action is not tied to an issue until approval, so "latest annex"
 * is the latest annex of the publication in any issue.
 */
export type AmendmentHeader =
  | { kind: "annexed"; annexedTo: number; positionOn: string }
  | { kind: "never" };

export { zurichPositionDay };

export function amendmentHeader(index: readonly AnnexIndexEntry[], publicationId: string): AmendmentHeader {
  const latest = runningAnnexes(index, Number.MAX_SAFE_INTEGER).find(c => c.id === publicationId);
  const positionOn = zurichPositionDay(latest?.position_on);
  if (!latest || latest.annexed_to === null || !positionOn) return { kind: "never" };
  return { kind: "annexed", annexedTo: latest.annexed_to, positionOn };
}

/** The `position_on` to prefill: the annexed position, as YYYY-MM-DD; empty when never annexed. */
export function positionPrefill(header: AmendmentHeader): string {
  return header.kind === "annexed" ? header.positionOn : "";
}

const textOf = (value: unknown): string => value instanceof YamlTimestamp ? value.text : value === undefined || value === null ? "" : String(value);

/**
 * Fill `position_on` with the annexed position of the chosen register. `prefilled` is the value this function put
 * there last time: while the field still holds exactly that, a new register replaces it (or clears it when the new
 * register was never annexed). A value the author typed or changed is never overwritten.
 */
export function applyPrefill(node: FormNode, day: string, prefilled: string): { node: FormNode; prefilled: string } {
  if (node.kind !== "object") return { node, prefilled };
  const field = node.fields.find(f => f.attr.name === "position_on");
  if (!field || (field.node && field.node.kind !== "leaf")) return { node, prefilled };
  const current = textOf(field.node?.value);
  if (current === "") return day ? { node: setField(node, "position_on", new YamlTimestamp(day)), prefilled: day } : { node, prefilled: "" };
  if (prefilled === "" || current !== prefilled) return { node, prefilled: "" };
  if (current === day) return { node, prefilled };
  return day ? { node: setField(node, "position_on", new YamlTimestamp(day)), prefilled: day } : { node: clearField(node, "position_on"), prefilled: "" };
}

/** Fill an empty `position_on` of an amendment form with the annexed position; never overwrites an author's value. */
export function prefillPosition(node: FormNode, day: string): FormNode {
  return applyPrefill(node, day, "").node;
}

/** The prefill day for the header state: empty when no register is chosen. */
export function registerPrefillDay(header: AmendmentHeader | null): string {
  return header ? positionPrefill(header) : "";
}

export interface PrefillState { annexDay: string; prefilled: string }
export const NO_PREFILL: PrefillState = { annexDay: "", prefilled: "" };
/** The register's day arrived (or was cleared): remember it and fill the form. */
export function prefillDay(state: PrefillState, node: FormNode, day: string): { state: PrefillState; node: FormNode } {
  const r = applyPrefill(node, day, state.prefilled);
  return { state: { annexDay: day, prefilled: r.prefilled }, node: r.node };
}
/** A new blank form: prefill it with the remembered day. */
export function freshPrefill(state: PrefillState, blank: FormNode): { state: PrefillState; node: FormNode } {
  return prefillDay({ annexDay: state.annexDay, prefilled: "" }, blank, state.annexDay);
}

/**
 * What the legacy AmendmentMeta printed above the position line (message-forms/amendment.tsx:93-103): "Per <recommendation>"
 * and "SP resource: <url>", both from the publication record (publications.ts `recommendation` and `url`).
 */
export interface PublicationSource {
  recommendation?: { body?: string; code: string; version?: string; title?: string } | null;
  /** The SP resource of the publication (dataset or list metadata `url`), not the recommendation page. */
  url?: string | null;
}
export interface SourceLines { recommendation: string | null; url: string | null }

/** Legacy RecommendationTitle (widgets/publication-title.tsx:26-40): "BODY Rec. CODE (YYYY-MM) Title", or "BODY CODE (YYYY-MM)" without a catalog title. */
export function sourceLines(source: PublicationSource | null | undefined): SourceLines {
  const rec = source?.recommendation;
  const version = rec?.version ? `(${String(rec.version).slice(0, 7)})` : "";
  const join = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(" ");
  const recommendation = rec?.code
    ? `Per ${rec.title ? join(rec.body, "Rec.", rec.code, version, rec.title) : join(rec.body, rec.code, version)}`
    : null;
  const url = source?.url?.trim() ? source.url.trim() : null;
  return { recommendation, url };
}
