/**
 * ITU Operational Bulletin date formatting.
 *
 * The official OB date format uses Roman numerals for the month:
 *   15.V.2016  →  15 May 2016
 *   1.IX.2010  →  1 September 2010
 *
 * This is the format used in every printed OB edition and on the
 * authoritative ITU website. The new site must render dates in this
 * same format for parity.
 */

const ROMAN_MONTHS = [
  "I", "II", "III", "IV", "V", "VI",
  "VII", "VIII", "IX", "X", "XI", "XII",
] as const;

const MONTH_NAMES_EN = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/** Parse an ISO date string (or Date) into a Date, returning null on failure. */
function toDate(input: string | Date | null | undefined): Date | null {
  if (input == null) return null;
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input;
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const d = new Date(trimmed);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Format a date in the official ITU Operational Bulletin style:
 * `DD.MM.YYYY` with the month as a Roman numeral.
 *
 * Example: `formatObDate("2016-05-15")` → `"15.V.2016"`.
 */
export function formatObDate(input: string | Date | null | undefined): string {
  const d = toDate(input);
  if (!d) return "";
  const day = d.getUTCDate();
  const month = d.getUTCMonth();
  const year = d.getUTCFullYear();
  return `${day}.${ROMAN_MONTHS[month]}.${year}`;
}

/**
 * Format a date with the month spelled out (English long form).
 *
 * Example: `formatLongDate("2016-05-15")` → `"15 May 2016"`.
 *
 * Use only for non-OB contexts (e.g. human-readable metadata). The OB
 * canonical format is `formatObDate`.
 */
export function formatLongDate(input: string | Date | null | undefined): string {
  const d = toDate(input);
  if (!d) return "";
  const day = d.getUTCDate();
  const month = d.getUTCMonth();
  const year = d.getUTCFullYear();
  return `${day} ${MONTH_NAMES_EN[month]} ${year}`;
}

/**
 * Format a date for compact archive lists.
 *
 * Example: `formatShortDate("2016-05-15")` → `"15.V.2016"`.
 *
 * Identical to `formatObDate` — kept as a separate name to convey intent
 * at the call site (the OB has only one date format).
 */
export function formatShortDate(input: string | Date | null | undefined): string {
  return formatObDate(input);
}

/** Extract the 4-digit year from an ISO date string. */
export function yearOf(input: string | Date | null | undefined): number | null {
  const d = toDate(input);
  return d ? d.getUTCFullYear() : null;
}

/**
 * Parse a Swiss/ITU-formatted date string (`15.V.2016`) back into a Date.
 * Returns null if the input does not match the expected pattern.
 */
export function parseObDate(text: string | null | undefined): Date | null {
  if (!text) return null;
  const m = text.trim().match(/^(\d{1,2})\.([IVX]+)\.(\d{4})$/);
  if (!m) return null;
  const day = Number.parseInt(m[1]!, 10);
  const monthIdx = ROMAN_MONTHS.indexOf(m[2] as typeof ROMAN_MONTHS[number]);
  if (monthIdx < 0) return null;
  const year = Number.parseInt(m[3]!, 10);
  const d = new Date(Date.UTC(year, monthIdx, day));
  return Number.isNaN(d.getTime()) ? null : d;
}
