/** Printed prose and form labels supplement typed entries, never replace them. */
import { listsRoot, obIssuesRoot, listFiles, join, readYamlOrNull, memoize } from "./fs";
import { listIssueIds } from "./loaders";
import { PUBLICATION_BY_SLUG } from "./catalogs";
import { resolveContent } from "./i18n";
import type { LocalizedContent, ProseMirrorNode } from "./types";

interface SourceMessage {
  target?: { publication?: string };
  contents?: LocalizedContent;
}

function textOf(node: ProseMirrorNode): string {
  if (node.type === "hard_break") return " ";
  return node.text ?? (node.content ?? []).map(textOf).join("");
}

function normalized(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function stringsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringsOf);
  return [];
}

/** Extract context only: ordinary table cells always stay in the typed layer. */
export function printedContext(nodes: ProseMirrorNode[], represented: unknown, formLabels = false): ProseMirrorNode[] {
  const known = stringsOf(represented).map(normalized);
  const seen = new Set<string>();
  const result: ProseMirrorNode[] = [];
  const add = (node: ProseMirrorNode) => {
    const key = normalized(textOf(node));
    if (!/[\p{L}\p{N}]/u.test(key) || seen.has(key) || known.some((value) => value.includes(key))) return;
    seen.add(key);
    result.push(node);
  };
  const emphasized = (node: ProseMirrorNode): boolean => {
    if (node.type === "text") return Boolean(node.marks?.some((m) => m.type === "em" || m.type === "strong"));
    return (node.content ?? []).every(emphasized);
  };
  const visit = (node: ProseMirrorNode) => {
    if (node.type !== "table") {
      if (node.type === "paragraph" || node.type === "heading") add(node);
      else (node.content ?? []).forEach(visit);
      return;
    }
    for (const [index, row] of (node.content ?? []).entries()) {
      const cells = row.content ?? [];
      // Printed column headings, including older docs that use styled cells.
      if (index === 0 && cells.length > 1 && cells.every((cell) => cell.type === "table_header" || emphasized(cell))) {
        cells.forEach((cell) => (cell.content ?? []).forEach(add));
      } else if (formLabels) {
        // T.35 uses a form: labels occupy the first cell or a spanning row.
        for (const paragraph of cells[0]?.content ?? []) {
          if (/[:?]/.test(textOf(paragraph)) && (cells.length > 1 || Number(cells[0]?.attrs?.colspan) > 1)) add(paragraph);
        }
      }
    }
  };
  nodes.forEach(visit);
  return result;
}

const sourceMessages = memoize((id: number): SourceMessage[] =>
  readYamlOrNull<{ messages?: SourceMessage[] }>(join(listsRoot(), "..", "issues", String(id), "amendments.yaml"))?.messages ?? [],
);

export const loadPrintedContext = memoize((id: number, slug: string): ProseMirrorNode[] => {
  const publication = PUBLICATION_BY_SLUG.get(slug)?.publicationId;
  if (!publication) return [];
  const directory = join(obIssuesRoot(), String(id), slug);
  const represented = listFiles(directory)
    .filter((file) => /^\d+.*\.yaml$/.test(file))
    .map((file) => readYamlOrNull(join(directory, file)));
  if (!represented.length) return [];
  const nodes = sourceMessages(id)
    .filter((message) => message.target?.publication === publication)
    .flatMap((message) => resolveContent(message.contents)?.content ?? []);
  return printedContext(nodes, represented, slug === "t35-na");
});

/** Keep each distinct note with its bulletin citation in the current register. */
export function registerPrintedContext(slug: string): { issue: number; nodes: ProseMirrorNode[] }[] {
  const seen = new Set<string>();
  return listIssueIds().flatMap((issue) => {
    const nodes = loadPrintedContext(issue, slug).filter((node) => {
      const key = normalized(textOf(node));
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return nodes.length ? [{ issue, nodes }] : [];
  });
}
