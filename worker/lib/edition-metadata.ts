import { stringify } from "yaml";
import type { IssueMetadataWire } from "../../src/lib/schema.generated.ts";
import { validateClass } from "../../src/lib/schema.validators.generated.ts";
import { auditStatements } from "./audit.ts";
import { requireRole } from "./authz.ts";
import { editionNo } from "./edition-number.ts";
import { ConflictError, InvalidError, NotFoundError } from "./membership.ts";
import { run, ValidationFailed } from "./submissions.ts";
import type { Session } from "./types.ts";
import type { FieldError } from "./validation.ts";

export interface EditionMetadata {
  ob_issue_no: number;
  metadata: IssueMetadataWire;
  revision: number;
  /** Local scheduling intent; neither a merged metadata PR nor publication evidence. */
  scheduled_at: string | null;
  updated_at: string;
}
interface Stored extends Omit<EditionMetadata, "metadata"> { metadata_json: string }
export interface MetadataArtifact {
  ob_issue_no: number;
  path: string;
  content: string;
  revision: number;
  publication_date: string;
  cutoff_date: string;
}

const staff = (s: Session | null) => requireRole(s, "itu-admin", "itu-editor");
const isoDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;

/** The generated ontology is authoritative for fields/nesting; scheduling adds real dates. */
export function validateMetadata(no: number, value: unknown, scheduling = false): IssueMetadataWire {
  editionNo(no);
  const errors: FieldError[] = validateClass("IssueMetadata", value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const m = value as Record<string, unknown>;
    if (m.id !== undefined && m.id !== no) errors.push({ path: "id", code: "mismatch", message: "id must equal the issue number" });
    if (scheduling && m.id === undefined) errors.push({ path: "id", code: "required", message: "id is required before scheduling" });
    for (const k of ["publication_date", "cutoff_date"] as const) {
      if ((scheduling || m[k] !== undefined) && !isoDate(m[k])) errors.push({ path: k, code: "type", message: `${k} must be a real calendar date (YYYY-MM-DD)` });
    }
    if (isoDate(m.cutoff_date) && isoDate(m.publication_date) && m.cutoff_date > m.publication_date)
      errors.push({ path: "cutoff_date", code: "mismatch", message: "cutoff_date must be on or before publication_date" });
  }
  if (errors.length) throw new ValidationFailed(errors);
  return value as IssueMetadataWire;
}

function revision(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new InvalidError("expected_revision must be a non-negative integer");
  return v;
}
async function stored(db: D1Database, no: number): Promise<EditionMetadata | null> {
  const row = await db.prepare("SELECT * FROM edition_metadata WHERE ob_issue_no=?1").bind(editionNo(no)).first<Stored>();
  if (!row) return null;
  const { metadata_json, ...rest } = row;
  return { ...rest, metadata: JSON.parse(metadata_json) };
}
export async function readMetadata(db: D1Database, session: Session | null, no: number): Promise<EditionMetadata | null> {
  staff(session);
  return stored(db, no);
}

/** Atomic optimistic writes and audit: stale editors cannot silently replace another draft. */
export async function saveMetadata(db: D1Database, session: Session | null, no: number, input: { metadata: unknown; expected_revision: unknown }): Promise<EditionMetadata> {
  const actor = staff(session);
  const metadata = validateMetadata(no, input.metadata);
  const expected = revision(input.expected_revision);
  const t = new Date().toISOString();
  const editable = `NOT EXISTS (SELECT 1 FROM editions WHERE ob_issue_no=?1 AND status IN ('composing','staged','published'))
    AND NOT EXISTS (SELECT 1 FROM edition_metadata_prs WHERE ob_issue_no=?1)`;
  const write = db.prepare(`INSERT INTO edition_metadata (ob_issue_no,metadata_json,revision,scheduled_at,updated_at)
    SELECT ?1,?2,1,NULL,?3 WHERE ${editable} ON CONFLICT(ob_issue_no) DO NOTHING`).bind(no, JSON.stringify(metadata), t);
  const update = db.prepare(`UPDATE edition_metadata SET metadata_json=?2,revision=revision+1,scheduled_at=NULL,updated_at=?3 WHERE ob_issue_no=?1 AND revision=?4 AND ${editable}`)
    .bind(no, JSON.stringify(metadata), t, expected);
  const result = await run(db, [expected === 0 ? write : update, ...(await auditStatements(db, [{
    at: t, actor_id: actor.userId, actor_kind: "user", action: "edition.metadata.saved", subject_type: "edition", subject_id: String(no), submission_id: null,
    detail: { revision: expected + 1, metadata },
  }], { sql: "changes()=1", args: [] }))]);
  if (!result[0]?.meta.changes) throw new ConflictError("metadata revision changed, edition is frozen, or a metadata PR is reserved; reload before saving");
  return { ob_issue_no: no, metadata, revision: expected + 1, scheduled_at: null, updated_at: t };
}

export async function scheduleMetadata(db: D1Database, session: Session | null, no: number, expectedRevision: unknown): Promise<EditionMetadata> {
  const actor = requireRole(session, "itu-admin");
  const expected = revision(expectedRevision);
  const current = await stored(db, no);
  if (!current) throw new NotFoundError("metadata draft required");
  if (current.revision !== expected) throw new ConflictError("metadata revision changed; reload before scheduling");
  validateMetadata(no, current.metadata, true);
  if (current.scheduled_at) return current;
  const t = new Date().toISOString();
  const result = await run(db, [db.prepare(`UPDATE edition_metadata SET scheduled_at=?3,updated_at=?3,revision=revision+1 WHERE ob_issue_no=?1 AND revision=?2 AND scheduled_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM editions WHERE ob_issue_no=?1 AND status IN ('composing','staged','published'))`).bind(no, expected, t),
    ...(await auditStatements(db, [{ at: t, actor_id: actor.userId, actor_kind: "user", action: "edition.metadata.scheduled", subject_type: "edition", subject_id: String(no), submission_id: null,
      detail: { revision: expected + 1, publication_date: current.metadata.publication_date, cutoff_date: current.metadata.cutoff_date },
    }], { sql: "changes()=1", args: [] }))]);
  if (!result[0]?.meta.changes) throw new ConflictError("metadata revision changed; reload before scheduling");
  return { ...current, revision: expected + 1, scheduled_at: t, updated_at: t };
}

/** Sort object keys recursively; retain array order and every optional authored field. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)]));
  return value;
}
/** Internal publisher seam: write this exact artifact only on a reviewed data-repo PR. */
export async function metadataArtifact(db: D1Database, no: number, expectedRevision?: number): Promise<MetadataArtifact> {
  const current = await stored(db, no);
  if (!current) throw new NotFoundError("metadata draft required");
  if (expectedRevision !== undefined && current.revision !== revision(expectedRevision)) throw new ConflictError("metadata revision changed");
  if (!current.scheduled_at) throw new ConflictError("schedule metadata before opening its review PR");
  const metadata = validateMetadata(no, current.metadata, true);
  return { ob_issue_no: no, path: `ob-issues/${no}/meta.yaml`, content: stringify(canonical(metadata), { lineWidth: 0 }), revision: current.revision,
    publication_date: metadata.publication_date!, cutoff_date: metadata.cutoff_date! };
}
