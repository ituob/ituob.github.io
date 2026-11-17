/**
 * Minimal AsciiDoc conversion for general messages whose content was
 * normalized as a file reference (e.g. "general/misc_comms.adoc").
 * Line-oriented: =/=-headings, paragraphs, bullet lists. All text is
 * HTML-escaped before inline markup is applied.
 */

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Inline markup. Superscript/subscript: `^x^` / `~x~` around alphanumerics
 *  (`^^x^^` kept for the older form). Known loss: a genuine `a^b^c` written
 *  as plain text would render as superscript. */
export function adocInline(s: string): string {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<strong>$1</strong>")
    .replace(/_([^_]+)_/g, "<em>$1</em>")
    .replace(/\^\^([^^]+)\^\^/g, "<sup>$1</sup>")
    // Single marks wrap alphanumerics only and are not adjacent to the same
    // mark, so `x^2+y^2`, `10^6-10^9`, `(~5,~10)`, `~user/a~b` and `~~x~~`
    // stay literal while `125^th^` and `H~2~O` render.
    .replace(/(?<!\^)\^([\p{L}\p{N}]+)\^(?!\^)/gu, "<sup>$1</sup>")
    .replace(/(?<!~)~([\p{L}\p{N}]+)~(?!~)/gu, "<sub>$1</sub>")
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
