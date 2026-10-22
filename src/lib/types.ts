/**
 * Typed schemas for OB data — the VIEW layer consumed by pages.
 *
 * Shared wire shapes are derived from schema.generated.ts, which is
 * generated from the LML ontology (ituob/lib/ituob/ontology/messages.lml,
 * scripts/generate_ts_types.rb) and regenerated in CI before every build.
 * Anything declared here that also exists on the wire imports the generated
 * interface instead of restating it, so `npm run check` fails when the site
 * drifts from the ontology.
 *
 * Not covered by the ontology (and therefore hand-written here): the
 * ob-issues file envelope (type/identifier/data framing), ProseMirror
 * documents, and view-level indexes derived from filenames.
 */
import type { ActionType, GeneralMessageType, Language } from "./catalogs";
import type {
  IdentifierWire,
  IssueAuthorWire,
  IssueContactWire,
  MultilingualStringWire,
} from "./schema.generated";

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

export interface ContactEntry extends IssueContactWire {
  type: "phone" | "fax" | "email" | "web" | "telex" | "other" | string;
  data: string;
}

export interface AuthorEntity extends IssueAuthorWire {
  contacts?: ContactEntry[];
}

export interface IssueMeta {
  incomplete?: boolean;
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

export interface AmendmentIdentifier extends IdentifierWire {}

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
  title: MultilingualStringWire;
  url?: string;
  source?: string;
  alias_of?: string;
  note?: MultilingualStringWire;
  locale?: Array<{
    key: string;
  } & Partial<Record<Language, string>>>;
  recommendation?: { body?: string; code?: string; version?: string };
}

/* -- Aggregated issue view (what the page consumes) ------------------------ */

export interface LoadedIssue {
  /** True when the issue carries no general messages or amendments (edition not fully populated). */
  incomplete?: boolean;
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
