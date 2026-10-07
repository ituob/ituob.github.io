/**
 * Typed schemas for OB data. Plain TypeScript interfaces (Zod-equivalent).
 * We avoid `any` — every shape is documented.
 *
 * These shapes match the YAML output of the ituob normalization pipeline.
 * See service-publications-docs/CONTEXT.md for the domain vocabulary.
 */
import type { ActionType, GeneralMessageType, Language } from "./catalogs";

/* -- ProseMirror document tree ---------------------------------------------- */

export interface ProseMirrorMark {
  type: "strong" | "em" | "link" | "superscript" | "subscript" | "code";
  attrs?: Record<string, unknown>;
}

export interface ProseMirrorNode {
  type:
    | "doc"
    | "paragraph"
    | "heading"
    | "text"
    | "hard_break"
    | "bullet_list"
    | "ordered_list"
    | "list_item"
    | "table"
    | "table_row"
    | "table_cell"
    | "table_header"
    | "blockquote"
    | "horizontal_rule";
  attrs?: Record<string, unknown>;
  content?: ProseMirrorNode[];
  marks?: ProseMirrorMark[];
  text?: string;
}

export interface ProseMirrorDoc {
  type: "doc";
  content: ProseMirrorNode[];
}

/** A localized content map (one ProseMirror doc per language). */
export type LocalizedContent = Partial<Record<Language, ProseMirrorDoc>>;

/* -- Issue metadata --------------------------------------------------------- */

export interface ContactEntry {
  type: "phone" | "fax" | "email" | "web" | "telex" | "other" | string;
  data: string;
  recommended?: boolean;
}

export interface AuthorEntity {
  name?: string;
  address?: string;
  contacts?: ContactEntry[];
}

export interface IssueMeta {
  id: number;
  publication_date: string;
  cutoff_date: string;
  issn: string;
  languages: Partial<Record<Language, boolean>>;
  authors: AuthorEntity[];
}

/* -- Annexes snapshot ------------------------------------------------------- */

export type AnnexesSnapshot = Record<string, { position_on?: string } | null>;

/* -- Structured general messages -------------------------------------------- */

export interface RunningAnnexesPayload {
  extra_links?: string[];
}
export interface RunningAnnexesMessage {
  ob_issue_no: string;
  type: "running_annexes";
  payload: RunningAnnexesPayload;
}

export interface ApprovedRecommendationsItem {
  code: string;
  version?: string;
}
export interface ApprovedRecommendationsPayload {
  items: Record<string, string | null>;
  by?: string;
  procedures?: string;
}
export interface ApprovedRecommendationsMessage {
  ob_issue_no: string;
  type: "approved_recommendations";
  payload: ApprovedRecommendationsPayload;
}

/* -- Textual general messages ----------------------------------------------- */

export interface TextualGeneralMessage {
  ob_issue_no: string;
  type: GeneralMessageType;
  contents: LocalizedContent;
}

/* -- Amendments (structured ChangeObjects) ---------------------------------- */

export interface AmendmentIdentifier {
  code?: string;
}

export interface AmendmentChangeEntry {
  _class?: string;
  position?: string;
  /** Verbatim printed change text (e.g. "P 27 COL 2 REP Batelco ... by Unitel"). */
  description?: string | null;
  /** Printed table-header wording (varies by action: "allocated"/"withdrawn"). */
  caption?: string | null;
  entries?: Record<string, unknown>[];
  /** Trailing glossary / abbreviation notes (e.g. "ISPC: International Signalling Point Codes."). */
  notes?: string[];
  [k: string]: unknown;
}

export interface StructuredAmendment {
  /** Action code (typically ActionType, but source data occasionally emits
   * non-standard codes — preserved verbatim). */
  type: ActionType | string;
  date_requested?: string | null;
  date_active?: string | null;
  ob_issue_no: string;
  reference?: string;
  identifier?: AmendmentIdentifier;
  data?: AmendmentChangeEntry;
}

/** Sequence index derived from filename (001-ADD.yaml → 1). */
export interface SequencedAmendment extends StructuredAmendment {
  /** Derived: slug of the publication (e.g. "e118-iin"). */
  slug: string;
  /** Derived: sequence number from filename. */
  seq: number;
  /** Derived: filename without extension. */
  fileStem: string;
}

/* -- Textual & placeholder amendments -------------------------------------- */

export interface TextAmendment {
  _class: "TextAmendment";
  ob_issue_no: string;
  reference?: string;
  contents: LocalizedContent;
}

export interface PlaceholderAmendment {
  _class: "PlaceholderAmendment";
  ob_issue_no: string;
  reference?: string;
}

/* -- Dataset metadata ------------------------------------------------------- */

export interface DatasetMetadata {
  title: Partial<Record<Language, string>>;
  url?: string;
  source?: string;
  alias_of?: string;
  note?: Partial<Record<Language, string>>;
  locale?: Array<{
    key: string;
  } & Partial<Record<Language, string>>>;
  recommendation?: { body?: string; code?: string; version?: string };
}

/* -- Aggregated issue view (what the page consumes) ------------------------ */

export interface LoadedIssue {
  id: number;
  meta: IssueMeta;
  annexes: AnnexesSnapshot;
  general: {
    runningAnnexes: RunningAnnexesMessage | null;
    approvedRecommendations: ApprovedRecommendationsMessage | null;
    textual: TextualGeneralMessage[];
  };
  amendments: {
    /** Map slug → sequenced structured amendments. */
    structured: Record<string, SequencedAmendment[]>;
    /** Map slug → textual amendment (one per issue). */
    textual: Record<string, TextAmendment>;
    /** Map slug → placeholder marker. */
    placeholder: Record<string, PlaceholderAmendment>;
  };
}
