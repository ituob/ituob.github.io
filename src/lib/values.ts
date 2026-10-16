/**
 * Cell-value formatting shared by StructuredAmendment and RegisterTable.
 *
 * The deployed pages print multilingual cells in full (e.g.
 * "ALLEMAGNE GERMANY ALEMANIA"), so every populated language is
 * rendered, in the OB's canonical fr/en/es order.
 */

// Canonical language order for multilingual cells.
export const LANGUAGE_KEYS = ["fr", "en", "es", "zh", "ru", "ar"] as const;

export function formatCellValue(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map((x) => formatCellValue(x)).join(", ");
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const languages = LANGUAGE_KEYS.filter((l) => typeof obj[l] === "string" && obj[l] !== "");
    if (languages.length > 0) return languages.map((l) => String(obj[l])).join(" ");
    return Object.values(obj).map(String).join(", ");
  }
  return String(v);
}
