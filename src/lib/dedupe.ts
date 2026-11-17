/**
 * De-duplication of general messages that exist twice: once as an
 * AsciiDoc asset reference (`contents: general/<file>.adoc`) and once
 * inlined as a ProseMirror document, both carrying the same text.
 * The asset-reference message is kept (it carries the heading
 * structure); the inlined twin is dropped.
 *
 * Equality is deliberately strict: markup is stripped, quotes and dashes
 * are unified, whitespace runs collapse, text is NFC + lowercase. Digits,
 * punctuation, spacing and combining marks all take part, so "3.5 MHz"
 * and "35 MHz" never match. Heading/paragraph/line structure is ignored
 * (blocks are joined by one space, and a block's trailing colon is
 * dropped because asset headings and inlined lines differ in it).
 */

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
    .trim()
    .toLowerCase();
}

function blockKey(block: string): string {
  return normalizeText(block).replace(/\s*:$/, "");
}

function stripAdocMarkup(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/\^\^([^^]+)\^\^/g, "$1")
    .replace(/(?<!\^)\^([\p{L}\p{N}]+)\^(?!\^)/gu, "$1")
    .replace(/(?<!~)~([\p{L}\p{N}]+)~(?!~)/gu, "$1")
    .replace(/`([^`]+)`/g, "$1");
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
  return blocks.map(stripAdocMarkup);
}

interface PMNode {
  type?: string;
  text?: string;
  content?: PMNode[];
}

/** Blocks of a ProseMirror node: a node whose children are all inline
 *  yields one block (children concatenated); others recurse. */
export function proseMirrorBlocks(node: unknown): string[] {
  if (!node || typeof node !== "object") return [];
  const n = node as PMNode;
  if (typeof n.text === "string") return [n.text];
  if (!Array.isArray(n.content)) return [];
  const inline = n.content.every(
    (c) => c && (typeof c.text === "string" || c.type === "hard_break" || c.type === "hardBreak"),
  );
  if (inline) {
    return [n.content.map((c) => (typeof c.text === "string" ? c.text : " ")).join("")];
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
  const { contents: _c, ...rest } = m as Record<string, unknown>;
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
