/**
 * De-duplication of general messages that exist twice: once as an
 * AsciiDoc asset reference (`contents: general/<file>.adoc`) and once
 * inlined as a ProseMirror document, both carrying the same text.
 * The asset-reference message is kept (it carries the heading
 * structure); the inlined twin is dropped.
 *
 * Equality is deliberately strict: quotes and dashes are unified,
 * whitespace runs collapse, text is NFC. Case, digits, punctuation,
 * spacing and combining marks all take part, so "3.5 MHz" and "35 MHz"
 * (or "mW" and "MW") never match. Emphasis, superscript and
 * subscript and code are kept as distinct tokens on both sides (asset markup and
 * ProseMirror marks), so "m^2^" never matches "m2". Heading/paragraph/line structure is ignored
 * (blocks are joined by one space, and a block's trailing colon is
 * dropped because asset headings and inlined lines differ in it).
 */

import { adocInlineWith, type InlineTag } from "./adoc.ts";

interface MessageLike {
  type: string;
  contents?: unknown;
}

export function normalizeText(s: string): string {
  return s
    .normalize("NFC")
    .replace(/[“”„‟«»]/g, '"')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function blockKey(block: string): string {
  return normalizeText(block).replace(/\s*:$/, "");
}

/** Mark tokens, private-use characters: open/close per tag. */
const TOKEN: Record<InlineTag, [string, string]> = {
  strong: ["\uE001", "\uE002"],
  em: ["\uE003", "\uE004"],
  sup: ["\uE005", "\uE006"],
  sub: ["\uE007", "\uE008"],
  code: ["\uE009", "\uE00A"],
};
// Outer-to-inner nesting used when ProseMirror marks are wrapped.
const MARK_ORDER: InlineTag[] = ["strong", "em", "sup", "sub", "code"];
const MARK_TYPE: Record<string, InlineTag> = {
  strong: "strong", bold: "strong", em: "em", italic: "em",
  superscript: "sup", subscript: "sub", code: "code",
};

const dropTokens = (s: string) => s.replace(/[\uE000-\uE00F]/g, "");
/** Adjacent same-tag runs (`</b><b>`) are one run. */
const joinRuns = (s: string) => s.replace(/([\uE002\uE004\uE006\uE008\uE00A])([\uE001\uE003\uE005\uE007\uE009])/g, (m, c, o) =>
  Object.values(TOKEN).some(([op, cl]) => op === o && cl === c) ? "" : m);

// Bold carries no meaning here (the real OB 1168 inlined twin lacks the
// asset's bold) so it is not compared; em, sup, sub and code are.
const COMPARED: Record<InlineTag, boolean> = { strong: false, em: true, sup: true, sub: true, code: true };

function tokenizeAdoc(s: string): string {
  return adocInlineWith(dropTokens(s), (t, x) => (COMPARED[t] ? `${TOKEN[t][0]}${x}${TOKEN[t][1]}` : x));
}

/** Blocks of an AsciiDoc text: headings and bullets stand alone,
 *  consecutive plain lines form one paragraph. */
export function adocBlocks(adoc: string): string[] {
  const blocks: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push(para.join(" "));
    para = [];
  };
  for (const raw of adoc.split("\n")) {
    const line = raw.trim();
    const standalone = line.match(/^(?:={1,6}|\*)\s+(.+)$/);
    if (!line) flush();
    else if (standalone) {
      flush();
      blocks.push(standalone[1]!);
    } else para.push(line);
  }
  flush();
  return blocks.map((b) => joinRuns(tokenizeAdoc(b)));
}

interface PMNode {
  type?: string;
  text?: string;
  marks?: { type?: string }[];
  content?: PMNode[];
}

function markedText(n: PMNode): string {
  const tags = new Set((n.marks ?? []).map((m) => MARK_TYPE[m.type ?? ""]).filter(Boolean));
  let out = dropTokens(n.text ?? "");
  for (const t of [...MARK_ORDER].reverse()) {
    if (COMPARED[t] && tags.has(t)) out = `${TOKEN[t][0]}${out}${TOKEN[t][1]}`;
  }
  return out;
}

/** Blocks of a ProseMirror node: a node whose children are all inline
 *  yields one block (children concatenated); others recurse. */
export function proseMirrorBlocks(node: unknown): string[] {
  if (!node || typeof node !== "object") return [];
  const n = node as PMNode;
  if (typeof n.text === "string") return [markedText(n)];
  if (!Array.isArray(n.content)) return [];
  const inline = n.content.every(
    (c) => c && (typeof c.text === "string" || c.type === "hard_break" || c.type === "hardBreak"),
  );
  if (inline) {
    return [joinRuns(n.content.map((c) => (typeof c.text === "string" ? markedText(c) : " ")).join(""))];
  }
  return n.content.flatMap(proseMirrorBlocks);
}

const joinBlocks = (blocks: string[]): string =>
  blocks.map(blockKey).filter(Boolean).join(" ");

/** Comparable text of an inlined message (all languages), or null when
 *  the message is not an inlined ProseMirror message. */
function inlinedKey(m: MessageLike): string | null {
  const c = m.contents;
  if (!c || typeof c !== "object" || Array.isArray(c)) return null;
  return joinBlocks(Object.values(c as Record<string, unknown>).flatMap(proseMirrorBlocks));
}

/** Fields other than contents, compared so an inlined message carrying
 *  extra data (e.g. a title) is never dropped as a twin. */
function otherFields(m: MessageLike): string {
  const { contents: _c, ...rest } = m as unknown as Record<string, unknown>;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

/**
 * Drop each inlined message whose text and other fields equal those of
 * an asset-reference message of the same type. `adocFor` returns the
 * asset text (null when unreadable; such a reference proves nothing).
 */
export function dedupeAssetTwins<T extends MessageLike>(
  messages: T[],
  adocFor: (m: T) => string | null,
): T[] {
  const assets = new Set<string>();
  for (const m of messages) {
    if (typeof m.contents !== "string") continue;
    const adoc = adocFor(m);
    if (adoc === null) continue;
    assets.add(`${otherFields(m)}\u0000${joinBlocks(adocBlocks(adoc))}`);
  }
  if (assets.size === 0) return messages;
  return messages.filter((m) => {
    const key = inlinedKey(m);
    if (key === null || key === "") return true;
    return !assets.has(`${otherFields(m)}\u0000${key}`);
  });
}
