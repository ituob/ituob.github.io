/**
 * Minimal AsciiDoc conversion for general messages whose content was
 * normalized as a file reference (e.g. "general/misc_comms.adoc").
 * Line-oriented: =/=-headings, paragraphs, bullet lists. All text is
 * HTML-escaped before inline markup is applied.
 */

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Inline markup. Superscript/subscript follow AsciiDoc: `^x^` / `~x~`
 *  (no whitespace inside); `^^x^^` is kept for the older form. */
export function adocInline(s: string): string {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<strong>$1</strong>")
    .replace(/_([^_]+)_/g, "<em>$1</em>")
    .replace(/\^\^([^^]+)\^\^/g, "<sup>$1</sup>")
    .replace(/\^([^\s^]+)\^/g, "<sup>$1</sup>")
    .replace(/~([^\s~]+)~/g, "<sub>$1</sub>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

export function adocToHtml(text: string): string {
  const blocks: string[] = [];
  let para: string[] = [];
  let list: string[] = [];
  const flushPara = () => {
    if (para.length) {
      blocks.push(`<p>${adocInline(para.join(" "))}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list.length) {
      blocks.push(`<ul>${list.map((i) => `<li>${adocInline(i)}</li>`).join("")}</ul>`);
      list = [];
    }
  };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const heading = line.match(/^(={2,5})\s+(.+)$/);
    const bullet = line.match(/^\*\s+(.+)$/);
    if (!line.trim()) {
      flushPara();
      flushList();
    } else if (heading) {
      flushPara();
      flushList();
      const level = Math.min(heading[1]!.length + 1, 6);
      blocks.push(`<h${level}>${adocInline(heading[2]!)}</h${level}>`);
    } else if (bullet) {
      flushPara();
      list.push(bullet[1]!);
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return blocks.join("\n");
}
