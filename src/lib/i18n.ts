/**
 * Resolve localized content: prefer requested language, fall back to English,
 * then to any available language.
 *
 * Also accepts an "unwrapped" ProseMirror doc (one whose top-level shape is
 * `{ type: 'doc', content: [...] }` rather than `{ en: { type: 'doc', ... } }`).
 * TextAmendment `text.yaml` files store the doc directly without a language
 * wrapper; we treat those as English.
 */
import type { LocalizedContent, ProseMirrorDoc } from "./types";
import type { Language } from "./catalogs";
import { SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE } from "./catalogs";

/** Returns true if the value looks like a bare ProseMirror doc. */
function isProseMirrorDoc(value: unknown): value is ProseMirrorDoc {
  return (
    typeof value === "object" && value !== null && "type" in value &&
    (value as { type: string }).type === "doc" && "content" in value
  );
}

export function resolveContent(
  content: LocalizedContent | undefined,
  lang: Language = DEFAULT_LANGUAGE,
): ProseMirrorDoc | null {
  if (!content) return null;

  // Unwrapped ProseMirror doc (text.yaml shape).
  if (isProseMirrorDoc(content)) {
    return content;
  }

  if (content[lang]) return content[lang]!;
  if (content[DEFAULT_LANGUAGE]) return content[DEFAULT_LANGUAGE]!;
  for (const l of SUPPORTED_LANGUAGES) {
    if (content[l]) return content[l]!;
  }
  return null;
}

/** Returns the list of languages actually present in a content object. */
export function availableLanguages(
  content: LocalizedContent | undefined,
): Language[] {
  if (!content) return [];
  if (isProseMirrorDoc(content)) {
    return [DEFAULT_LANGUAGE];
  }
  return SUPPORTED_LANGUAGES.filter((l) => content[l]);
}

