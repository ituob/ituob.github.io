/**
 * Formatting helpers for the ITU Operational Bulletin site.
 *
 * The OB uses a single canonical date format: Roman-numeral month,
 * written as `DD.MONTH_AS_ROMAN.YYYY` (e.g. `15.V.2016`). Every date
 * shown on the site must use this format for parity with the printed
 * bulletin and the authoritative ITU website.
 */
export {
  formatObDate,
  formatLongDate,
  formatShortDate,
  yearOf,
  parseObDate,
} from "./ob-date";

/**
 * @deprecated Use {@link formatObDate} directly.
 *
 * Historical name preserved so existing call sites continue to render
 * in the canonical OB format. The implementation now delegates to
 * `formatObDate`.
 */
export { formatObDate as formatSwissDate } from "./ob-date";

/** HTML-escape. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Slugify an ITU-T Recommendation code for use as a single URL path segment.
 * Recommendation codes may contain `/` (e.g. "G.780/Y.1351"); we replace it
 * with `_` to keep the code a single segment. The reverse op is `deslugifyRecCode`.
 */
export function slugifyRecCode(code: string): string {
  return code.replace(/\//g, "_");
}

export function deslugifyRecCode(slug: string): string {
  return slug.replace(/_/g, "/");
}
