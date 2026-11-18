import { setField, type FormNode } from "./model";
import { YamlTimestamp } from "./yaml-io";
import { positionDay, runningAnnexes, type AnnexIndexEntry } from "./annexes";

/**
 * The amendment header of the legacy editor (message-forms/amendment.tsx AmendmentMeta):
 * "Amending position of DATE annexed to OB n", or a warning when the publication has no
 * annexed position. An action is not tied to an issue until approval, so "latest annex"
 * is the latest annex of the publication in any issue.
 */
export type AmendmentHeader =
  | { kind: "annexed"; annexedTo: number; positionOn: string }
  | { kind: "never" };

export function amendmentHeader(index: readonly AnnexIndexEntry[], publicationId: string): AmendmentHeader {
  const latest = runningAnnexes(index, Number.MAX_SAFE_INTEGER).find(c => c.id === publicationId);
  const positionOn = positionDay(latest?.position_on ?? undefined);
  if (!latest || latest.annexed_to === null || !positionOn) return { kind: "never" };
  return { kind: "annexed", annexedTo: latest.annexed_to, positionOn };
}

/** The `position_on` to prefill: the annexed position, as YYYY-MM-DD; empty when never annexed. */
export function positionPrefill(header: AmendmentHeader): string {
  return header.kind === "annexed" ? header.positionOn : "";
}

/** Fill an empty `position_on` of an amendment form with the annexed position; never overwrites an author's value. */
export function prefillPosition(node: FormNode, day: string): FormNode {
  if (!day || node.kind !== "object") return node;
  const field = node.fields.find(f => f.attr.name === "position_on");
  if (!field || (field.node && field.node.kind !== "leaf")) return node;
  const current = field.node?.value;
  if (current !== undefined && current !== null && current !== "") return node;
  return setField(node, "position_on", new YamlTimestamp(day));
}
