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
    if (!/[\p{L}\p{N}]/u.test(key) || seen.has(key) || known.includes(key)) return;
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
      // The older French E.212 heading is plain table cells, without marks.
      const frenchE212Header = cells.length === 3 && cells.map((cell) => normalized(textOf(cell))).join("|") ===
        "pays/zone géographique|mcc + mnc*|nom de réseau/opérateur";
      // Printed column headings, including older docs that use styled cells.
      if (index === 0 && cells.length > 1 && (frenchE212Header || cells.every((cell) => cell.type === "table_header" || emphasized(cell)))) {
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

/** Display-only labels from otherwise empty F.32 continuation rows. */
export function blankContinuationLabels(nodes: ProseMirrorNode[]): string[] {
  const labels: string[] = [];
  const blankCell = (node: ProseMirrorNode): boolean =>
    ["table_cell", "paragraph", "text", "hard_break"].includes(node.type) &&
    (node.text ?? "").trim() === "" && (node.content ?? []).every(blankCell);
  const visit = (node: ProseMirrorNode) => {
    if (node.type !== "table") {
      (node.content ?? []).forEach(visit);
      return;
    }
    let previousCountry = "";
    for (const row of node.content ?? []) {
      const cells = row.content ?? [];
      if (cells.length !== 5 || cells.some((cell) => cell.type !== "table_cell")) {
        previousCountry = "";
        continue;
      }
      const label = textOf(cells[0]!).trim();
      const blank = cells.slice(1).every(blankCell);
      if (label && blank && label === previousCountry) labels.push(label);
      else previousCountry = label && !blank ? label : "";
    }
  };
  nodes.forEach(visit);
  return labels;
}

export const loadBlankContinuationLabels = memoize((id: number, slug: string): string[] => {
  if (slug !== "f32-tdi") return [];
  const publication = PUBLICATION_BY_SLUG.get(slug)?.publicationId;
  const nodes = sourceMessages(id)
    .filter((message) => message.target?.publication === publication)
    .flatMap((message) => resolveContent(message.contents)?.content ?? []);
  return blankContinuationLabels(nodes);
});

/** Recover an explicit Country B relation only for an already represented operator/code. */
export function e212CountryContext(nodes: ProseMirrorNode[], represented: unknown): ProseMirrorNode[] {
  const entries: Record<string, unknown>[] = [];
  const collect = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") {
      const object = value as Record<string, unknown>;
      if (typeof object.mcc_mnc_codes === "string" && typeof object.networks === "string") entries.push(object);
      else Object.values(object).forEach(collect);
    }
  };
  collect(represented);
  const result: ProseMirrorNode[] = [];
  const seen = new Set<string>();
  const visit = (node: ProseMirrorNode) => {
    if (node.type !== "table") {
      (node.content ?? []).forEach(visit);
      return;
    }
    const rows = node.content ?? [];
    const headings = (rows[0]?.content ?? []).map((cell) => normalized(textOf(cell)));
    if (headings.length !== 5 || !/mcc.*mnc/.test(headings[0]!) ||
        !/name of operator/.test(headings[1]!) || !/country b.*extra-territorially/.test(headings[2]!) ||
        !/msin range.*country a/.test(headings[3]!) || !/msin range.*country b/.test(headings[4]!)) return;
    for (const row of rows.slice(1)) {
      const cells = row.content ?? [];
      if (cells.length !== 5) continue;
      const [code, operator, country] = cells.slice(0, 3).map((cell) => textOf(cell).trim());
      if (!country) continue;
      const entry = entries.find((entry) => normalized(String(entry.mcc_mnc_codes)) === normalized(code!) &&
        normalized(String(entry.networks)) === normalized(operator!));
      if (!entry || stringsOf(entry).map(normalized).includes(normalized(country))) continue;
      const text = `${operator} (${code}) — Country B: ${country}`;
      if (seen.has(text)) continue;
      seen.add(text);
      result.push({ type: "paragraph", content: [{ type: "text", text }] });
    }
  };
  nodes.forEach(visit);
  return result;
}

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
  if (slug === "list-viii") {
    // Space-station specifications use numbered headings outside tables;
    // the typed notes retain the values, but omit these field descriptions.
    const headings: ProseMirrorNode[] = [];
    const representedHeadings = stringsOf(represented).map(normalized);
    const visit = (node: ProseMirrorNode) => {
      if ((node.type === "heading" || node.type === "paragraph") && /^\s*\d+\.\s+/.test(textOf(node))) {
        const index = representedHeadings.indexOf(normalized(textOf(node)));
        if (index >= 0) representedHeadings.splice(index, 1);
        else headings.push(node);
      }
      else (node.content ?? []).forEach(visit);
    };
    nodes.forEach(visit);
    return headings;
  }
  const context = printedContext(nodes, represented, slug === "t35-na");
  return slug === "e212-mnc" ? [...context, ...e212CountryContext(nodes, represented)] : context;
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
