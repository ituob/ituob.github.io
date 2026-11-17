/**
 * Resolve localized content: prefer requested language, fall back to English,
 * then to any available language.
 *
 * Also accepts an "unwrapped" ProseMirror doc (one whose top-level shape is
 * `{ type: 'doc', content: [...] }` rather than `{ en: { type: 'doc', ... } }`).
 * TextAmendment `text.yaml` files store the doc directly without a language
 * wrapper; we treat those as English.
 */
import type { ProseMirrorDoc } from "./types";
import type { Language } from "./catalogs";
import { SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE } from "./catalogs";

/** Returns true if the value looks like a bare ProseMirror doc. */
function isProseMirrorDoc(value: unknown): value is ProseMirrorDoc {
  return (
    typeof value === "object" && value !== null && "type" in value &&
    (value as { type: string }).type === "doc" && "content" in value &&
    Array.isArray(value.content)
  );
}

export function resolveContent(
  content: unknown,
  lang: Language = DEFAULT_LANGUAGE,
): ProseMirrorDoc | null {
  const resolved = resolveGeneralContent(content, lang);
  return isProseMirrorDoc(resolved) ? resolved : null;
}

/** Resolve authored prose and readonly legacy documents without interpreting HTML. */
export function resolveGeneralContent(
  content: unknown,
  lang: Language = DEFAULT_LANGUAGE,
): string | ProseMirrorDoc | null {
  if (typeof content === "string" || isProseMirrorDoc(content)) return content;
  if (!content || typeof content !== "object" || Array.isArray(content)) return null;
  const localized = content as Record<string, unknown>;
  for (const language of new Set([lang, DEFAULT_LANGUAGE, ...SUPPORTED_LANGUAGES])) {
    const value = localized[language];
    if (typeof value === "string" || isProseMirrorDoc(value)) return value;
  }
  return null;
}

/** Discover languages in prose or nested General payloads, excluding asset references. */
export function availableLanguages(
  content: unknown,
): Language[] {
  if (typeof content === "string") {
    return content.endsWith(".adoc") ? [] : [DEFAULT_LANGUAGE];
  }
  if (isProseMirrorDoc(content)) return [DEFAULT_LANGUAGE];
  if (!content || typeof content !== "object") return [];
  const found = new Set<Language>();
  for (const [key, value] of Object.entries(content)) {
    if (SUPPORTED_LANGUAGES.includes(key as Language)) {
      if ((typeof value === "string" && !value.endsWith(".adoc")) || isProseMirrorDoc(value)) {
        found.add(key as Language);
      }
    } else if (value && typeof value === "object") {
      for (const language of availableLanguages(value)) found.add(language);
    }
  }
  return SUPPORTED_LANGUAGES.filter((language) => found.has(language));
}
