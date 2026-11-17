/**
 * De-duplication of general messages that exist twice: once as an
 * AsciiDoc asset reference (`contents: general/<file>.adoc`) and once
 * inlined as a ProseMirror document, both carrying the same text.
 * The asset-reference message is kept (it carries the heading
 * structure); the inlined twin is dropped.
 */

interface MessageLike {
  type: string;
  contents?: unknown;
}

/** Letters and digits only, lowercased: robust to quote style, trailing
 *  colons, markup and whitespace. */
export function normalizeText(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

export function adocPlainText(adoc: string): string {
  return adoc
    .split("\n")
    .map((l) => l.replace(/^={1,6}\s+/, "").replace(/^\*\s+/, ""))
    .join(" ")
    .replace(/\^\^?([^\s^]+)\^\^?/g, "$1")
    .replace(/~([^\s~]+)~/g, "$1")
    .replace(/[*_`]/g, "");
}

function proseMirrorText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as { text?: unknown; content?: unknown };
  if (typeof n.text === "string") return n.text;
  return Array.isArray(n.content) ? n.content.map(proseMirrorText).join(" ") : "";
}

/** All inlined text of a message (every language), or null when the
 *  message is not an inlined ProseMirror message. */
function inlinedText(m: MessageLike): string | null {
  const c = m.contents;
  if (!c || typeof c !== "object" || Array.isArray(c)) return null;
  return Object.values(c as Record<string, unknown>).map(proseMirrorText).join(" ");
}

/**
 * Drop each inlined message whose text equals the text of an
 * asset-reference message of the same type. `adocFor` returns the asset
 * text (null when the asset is unreadable; such a reference cannot
 * prove a duplicate, so nothing is dropped for it).
 */
export function dedupeAssetTwins<T extends MessageLike>(
  messages: T[],
  adocFor: (m: T) => string | null,
): T[] {
  const assetNorms = new Map<string, Set<string>>();
  for (const m of messages) {
    if (typeof m.contents !== "string") continue;
    const adoc = adocFor(m);
    if (adoc === null) continue;
    const set = assetNorms.get(m.type) ?? new Set<string>();
    set.add(normalizeText(adocPlainText(adoc)));
    assetNorms.set(m.type, set);
  }
  if (assetNorms.size === 0) return messages;
  return messages.filter((m) => {
    const inl = inlinedText(m);
    if (inl === null) return true;
    const norm = normalizeText(inl);
    return !(norm && assetNorms.get(m.type)?.has(norm));
  });
}
