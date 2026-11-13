import { blankState, setField } from "./model.ts";
import { classify } from "./corpus.ts";

// Names are UI choices only: corpus.classify owns the authoritative class binding.
export const GENERAL_TYPES = ["approved_recommendations", "callback_procedures", "custom", "ipns", "iptn", "mid", "misc_communications", "org_changes", "running_annexes", "sanc", "service_restrictions", "telephone_service", "telephone_service_2"] as const;
export function generalBinding(type: unknown, sequence = 1): { className: string; relativePath: string } {
  if (typeof type !== "string" || !(GENERAL_TYPES as readonly string[]).includes(type)) throw new Error("unknown canonical general-message type");
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 999) throw new Error("general-message sequence must be between 1 and 999");
  const relativePath = ["approved_recommendations", "running_annexes"].includes(type)
    ? `general/${type}.yaml` : `${type}/${String(sequence).padStart(3, "0")}.yaml`;
  const binding = classify(relativePath, { type });
  if (!binding || binding.role !== "general") throw new Error("unsupported canonical general-message type");
  return { className: binding.className, relativePath };
}

/** New drafts use raw wire values; form nodes are produced by setField. */
export function newGeneralState(type: string) {
  return setField(blankState(generalBinding(type).className), "type", type);
}

export const PROSE_LANGUAGES = ["en", "fr", "es", "ar", "ru", "zh"] as const;
export function isLanguageProse(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    PROSE_LANGUAGES.some(language => Object.hasOwn(value, language));
}
/** Edit only scalar language text. Legacy document objects cannot be overwritten here. */
export function setProseLanguage(value: unknown, language: string, text: string): Record<string, unknown> {
  if (!(PROSE_LANGUAGES as readonly string[]).includes(language)) throw new Error("unsupported prose language");
  const languages = typeof value === "string" ? { en: value } : isLanguageProse(value) ? value : {};
  if (languages[language] !== undefined && typeof languages[language] !== "string") throw new Error("stored rich text is preserved read-only");
  return { ...languages, [language]: text };
}
