import { clearField, setField, type FormNode } from "./model";
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

const ZURICH_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit" });

/**
 * The calendar day of a stored `position_on` as the ITU (Geneva) reads it. The corpus stores a Zurich midnight as
 * T22:00Z (summer) or T23:00Z (winter), so the UTC date is the day before; a bare date is returned unchanged.
 */
export function zurichPositionDay(position: string | null | undefined): string {
  const day = positionDay(position ?? undefined);
  if (!day || !position || position.length === 10) return day;
  const at = new Date(position);
  if (Number.isNaN(at.getTime())) return day;
  const part = (type: string) => ZURICH_DAY.formatToParts(at).find(p => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

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
