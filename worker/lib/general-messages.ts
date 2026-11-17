import { stringify } from "yaml";
import { packJSON, packText, unpackJSON, unpackText } from "./general-message-storage.ts";
import { parseYaml, stringifyYamlPreservingSource } from "../../src/lib/form/yaml-io.ts";
import { type RepoReader } from "./repo-reader.ts";
import { draftBinding, generalBinding, isSingletonPath } from "../../src/lib/form/general.ts";
import { ANNEX_TYPE, validateAnnexes } from "../../src/lib/form/annexes.ts";
export { draftBinding, generalBinding, GENERAL_TYPES } from "../../src/lib/form/general.ts";
import { validateClass } from "../../src/lib/schema.validators.generated.ts";
import { auditStatements } from "./audit.ts";
import { requireRole } from "./authz.ts";
import { editionNo } from "./edition-number.ts";
import { ConflictError, InvalidError, NotFoundError } from "./membership.ts";
import { run, ValidationFailed } from "./submissions.ts";
import type { Session } from "./types.ts";
import { ulid } from "./ulid.ts";

export interface GeneralMessage {
  id: string; ob_issue_no: number; type: string; class_name: string; path: string;
  value: Record<string, unknown>; revision: number; approved_at: string | null;
  approved_by: string | null; content_yaml: string | null; updated_at: string;
}
interface Stored extends Omit<GeneralMessage, "value"> { value_json: string; source_yaml: string | null }
export interface GeneralMessageArtifact {
  id: string; ob_issue_no: number; type: string; class_name: string; path: string; revision: number; content: string;
}
const staff = (s: Session | null) => requireRole(s, "itu-admin", "itu-editor");
const SANC_LIMITS = { items: 500, field: 200, notes: 10_000, contents: 200_000 };
function hasRichText(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const node = value as Record<string, unknown>;
  if (node.type === "text") return typeof node.text === "string" && node.text.trim() !== "";
  return Array.isArray(node.content) && node.content.some(hasRichText);
}
function hasLegacySancContents(contents: unknown): boolean {
  if (!contents || typeof contents !== "object" || Array.isArray(contents)) return false;
  return Object.values(contents).some(doc => doc && typeof doc === "object" && !Array.isArray(doc)
    && (doc as Record<string, unknown>).type === "doc" && hasRichText(doc));
}
/** Typed notices require assignments; historical notices store them in rich documents instead. */
function sancErrors(record: Record<string, unknown>) {
  const errors: { path: string; code: "type" | "required"; message: string }[] = [];
  const bad = (path: string, code: "type" | "required", message: string) => errors.push({ path, code, message });
  const items = record.items;
  const legacyContents = !("items" in record) && hasLegacySancContents(record.contents);
  if (!legacyContents && (!Array.isArray(items) || items.length === 0)) bad("items", "required", "a SANC message needs at least one item");
  else if (Array.isArray(items)) {
    if (items.length > SANC_LIMITS.items) bad("items", "type", `at most ${SANC_LIMITS.items} items`);
    items.forEach((item, i) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return bad(`items.${i}`, "type", "item must be an object");
      for (const field of ["country", "sanc"]) {
        const v = (item as Record<string, unknown>)[field];
        if (typeof v !== "string" || v.trim() === "") bad(`items.${i}.${field}`, "required", `${field} is required`);
        else if (v.length > SANC_LIMITS.field) bad(`items.${i}.${field}`, "type", `${field} must be at most ${SANC_LIMITS.field} characters`);
      }
    });
  }
  if ("contents" in record) {
    const c = record.contents;
    if (c === null || c === undefined || (typeof c === "string" && c.trim() === "")) bad("contents", "required", "contents must not be null or empty");
    else if (JSON.stringify(c).length > SANC_LIMITS.contents) bad("contents", "type", "contents is too large");
  }
  if ("notes" in record) {
    const n = record.notes;
    if (typeof n !== "string") bad("notes", "type", "notes must be a string");
    else if (n.length > SANC_LIMITS.notes) bad("notes", "type", `notes must be at most ${SANC_LIMITS.notes} characters`);
  }
  return errors;
}
export function validateGeneralMessage(type: unknown, value: unknown): { className: string; value: Record<string, unknown> } {
  let className: string;
  try { ({ className } = draftBinding(type)); } catch (error) { throw new InvalidError(error instanceof Error ? error.message : "invalid general-message type"); }
  // Annexes are a mapping keyed by publication id with no message envelope; the shared
  // annex rules (also run in the browser) replace the envelope checks below.
  if (type === ANNEX_TYPE) {
    const annexErrors = validateAnnexes(value);
    if (annexErrors.length) throw new ValidationFailed(annexErrors);
    return { className, value: value as Record<string, unknown> };
  }
  const errors = validateClass(className, value);
  if (!value || typeof value !== "object" || Array.isArray(value)) errors.push({ path: "", code: "type", message: "message must be an object" });
  else {
    const record = value as Record<string, unknown>;
    if (record.type !== type) errors.push({ path: "type", code: "type", message: "type must match the canonical message directory" });
    if (record._class !== undefined && record._class !== className) errors.push({ path: "_class", code: "type", message: "class must match the canonical message type" });
    if (type === "sanc") errors.push(...sancErrors(record));
  }
  if (errors.length) throw new ValidationFailed(errors);
  return { className, value: value as Record<string, unknown> };
}
function checkIssue(no: number, type: unknown, value: Record<string, unknown>) {
  if (type === ANNEX_TYPE) return; // annexes.yaml has no issue field: the directory is the issue
  if (value.ob_issue_no !== String(no))
    throw new ValidationFailed([{ path: "ob_issue_no", code: "type", message: "ob_issue_no must match the canonical issue directory" }]);
}
function expectedRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new InvalidError("expected_revision must be a positive integer");
  return value;
}
async function decode(row: Stored): Promise<GeneralMessage> {
  const { value_json, source_yaml, content_yaml, ...rest } = row;
  return { ...rest, value: await unpackJSON(value_json), content_yaml: content_yaml === null ? null : await unpackText(content_yaml) };
}
async function stored(db: D1Database, id: string): Promise<GeneralMessage> {
  const row = await db.prepare("SELECT * FROM general_messages WHERE id=?1").bind(id).first<Stored>();
  if (!row) throw new NotFoundError("general-message draft not found");
  return decode(row);
}
export async function readGeneralMessage(db: D1Database, session: Session | null, id: string) { staff(session); return stored(db, id); }
export async function listGeneralMessages(db: D1Database, session: Session | null) {
  staff(session);
  return Promise.all((await db.prepare("SELECT * FROM general_messages ORDER BY ob_issue_no DESC,path").all<Stored>()).results.map(decode));
}
async function audit(db: D1Database, actor: Session, id: string, no: number, action: string, revision: number, at: string) {
  return auditStatements(db, [{ at, actor_id: actor.userId, actor_kind: "user", action, subject_type: "edition", subject_id: String(no), submission_id: null, detail: { message_id: id, revision } }], { sql: "changes()=1", args: [] });
}
/** Sequence assignment is atomic within D1. The publisher must also reject an
 * existing canonical base path: this local DB is not an inventory of legacy Git. */
export async function createGeneralMessage(db: D1Database, session: Session | null, input: { ob_issue_no: unknown; type: unknown; value: unknown }) {
  const actor = staff(session), no = editionNo(input.ob_issue_no);
  const { className, value } = validateGeneralMessage(input.type, input.value);
  checkIssue(no,input.type,value);
  const type = input.type as string, binding = draftBinding(type), id = ulid(), at = new Date().toISOString();
  const singleton = isSingletonPath(binding.relativePath);
  const prefix = `ob-issues/${no}/${type}/`;
  const pathSql = singleton ? "?7" : `?7 || printf('%03d',coalesce((SELECT max(CAST(substr(path,length(?7)+1,3) AS INTEGER)) FROM general_messages WHERE ob_issue_no=?2 AND type=?3),0)+1) || '.yaml'`;
  const write = db.prepare(`INSERT INTO general_messages (id,ob_issue_no,type,class_name,path,value_json,revision,updated_at)
    SELECT ?1,?2,?3,?4,${pathSql},?5,1,?6
    WHERE NOT EXISTS (SELECT 1 FROM editions WHERE ob_issue_no=?2 AND status IN ('composing','staged','published'))
    AND (SELECT count(*) FROM general_messages WHERE ob_issue_no=?2 AND type=?3) < ?8
    ON CONFLICT(path) DO NOTHING`).bind(id,no,type,className,await packJSON(value),at,singleton ? `ob-issues/${no}/${binding.relativePath}` : prefix,singleton ? 1 : 999);
  const result = await run(db, [write, ...await audit(db,actor,id,no,"general.message.created",1,at)]);
  if (!result[0]?.meta.changes) throw new ConflictError("issue is frozen, singleton already exists, or message sequence exhausted");
  return stored(db,id);
}
export async function saveGeneralMessage(db: D1Database, session: Session | null, id: string, input: { expected_revision: unknown; value: unknown }) {
  const actor = staff(session), current = await stored(db,id), expected = expectedRevision(input.expected_revision);
  const { value } = validateGeneralMessage(current.type,input.value), at = new Date().toISOString();
  checkIssue(current.ob_issue_no,current.type,value);
  const result = await run(db,[db.prepare(`UPDATE general_messages SET value_json=?3,revision=revision+1,approved_at=NULL,approved_by=NULL,content_yaml=NULL,updated_at=?4
    WHERE id=?1 AND revision=?2 AND NOT EXISTS (SELECT 1 FROM general_message_prs WHERE message_id=?1)
    AND NOT EXISTS (SELECT 1 FROM editions WHERE ob_issue_no=?5 AND status IN ('composing','staged','published'))`).bind(id,expected,await packJSON(value),at,current.ob_issue_no),
    ...await audit(db,actor,id,current.ob_issue_no,"general.message.saved",expected+1,at)]);
  if (!result[0]?.meta.changes) throw new ConflictError("revision changed, issue frozen, or review PR reserved; reload before editing");
  return stored(db,id);
}
const existingPath = /^ob-issues\/([1-9]\d*)\/(general\/[a-z_]+|[a-z0-9_]+\/\d{3})\.yaml$/;
/** The one canonical path of a record: generalBinding owns it (singletons under general/, the rest NNN-numbered). */
function canonicalImport(no: number, path: unknown): string {
  const match = typeof path === "string" ? existingPath.exec(path) : null;
  const bad = () => new InvalidError("path must be the canonical existing ob-issues/<issue>/<type>/NNN.yaml or general/<type>.yaml record of that issue");
  if (!match || Number(match[1]) !== no) throw bad();
  const [dir, file] = match[2]!.split("/") as [string, string];
  const type = dir === "general" ? file : dir;
  try { if (generalBinding(type, dir === "general" ? 1 : Number(file)).relativePath !== `${match[2]}.yaml`) throw bad(); }
  catch (error) { throw error instanceof InvalidError ? error : bad(); }
  return type;
}
/**
 * Open an existing canonical record from the data repository as a draft (map row D3). The file is read
 * through the repository reader, must validate as its class exactly as a new draft does (nothing is
 * rewritten to make it pass), and keeps its path, so approval produces a replacement of that file in a
 * reviewed PR, never a direct write.
 */
export async function importGeneralMessage(db: D1Database, session: Session | null, input: { ob_issue_no: unknown; path: unknown }, reader: RepoReader, repo: string) {
  const actor = staff(session), no = editionNo(input.ob_issue_no);
  const type = canonicalImport(no, input.path);
  const text = await reader.read(repo, input.path as string);
  if (text === null) throw new NotFoundError("no such record in the data repository");
  let value: unknown;
  // Use the corpus YAML dialect, then the same JSON wire representation as the
  // browser and D1. Original timestamp spelling remains in source_yaml.
  try { value = JSON.parse(JSON.stringify(parseYaml(text))); } catch { throw new ValidationFailed([{ path: "", code: "type", message: "record is not valid YAML" }]); }
  const { className, value: valid } = validateGeneralMessage(type, value);
  checkIssue(no, type, valid);
  const id = ulid(), at = new Date().toISOString();
  const write = db.prepare(`INSERT INTO general_messages (id,ob_issue_no,type,class_name,path,value_json,revision,updated_at,source_yaml)
    SELECT ?1,?2,?3,?4,?5,?6,1,?7,?8 WHERE NOT EXISTS (SELECT 1 FROM editions WHERE ob_issue_no=?2 AND status IN ('composing','staged','published'))
    ON CONFLICT(path) DO NOTHING`).bind(id, no, type, className, input.path, await packJSON(valid), at, await packText(text));
  const result = await run(db, [write, ...await audit(db, actor, id, no, "general.message.imported", 1, at)]);
  if (!result[0]?.meta.changes) throw new ConflictError("a draft of this record already exists or the issue is frozen");
  return stored(db, id);
}

/** Remove a draft that is not currently approved and not under review. A reserved publication PR, a standing
 * approval or a frozen edition keep the record: published work is withdrawn through review, not deleted here.
 * Approval snapshots of earlier revisions (saving clears the approval) go with the draft; the audit log keeps them. */
export async function deleteGeneralMessage(db: D1Database, session: Session | null, id: string, revision: unknown) {
  const actor = staff(session), expected = expectedRevision(revision), current = await stored(db,id), at = new Date().toISOString();
  if (current.revision !== expected) throw new ConflictError("general-message revision changed; reload before deleting");
  const deletable = `EXISTS (SELECT 1 FROM general_messages WHERE id=?1 AND revision=?2 AND approved_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM general_message_prs WHERE message_id=?1)
    AND NOT EXISTS (SELECT 1 FROM editions WHERE ob_issue_no=?3 AND status IN ('composing','staged','published'))`;
  const result = await run(db,[db.prepare(`DELETE FROM general_message_approvals WHERE message_id=?1 AND ${deletable}`).bind(id,expected,current.ob_issue_no),
    db.prepare(`DELETE FROM general_messages WHERE id=?1 AND ${deletable}`).bind(id,expected,current.ob_issue_no),
    ...await audit(db,actor,id,current.ob_issue_no,"general.message.deleted",expected,at)]);
  if (!result[1]?.meta.changes) throw new ConflictError("message is approved, has a reserved review PR, or its issue is frozen; it cannot be deleted");
  return { id, deleted: true };
}
export async function approveGeneralMessage(db: D1Database, session: Session | null, id: string, revision: unknown) {
  const actor = requireRole(session,"itu-admin"), expected = expectedRevision(revision), current = await stored(db,id);
  if (current.revision !== expected) throw new ConflictError("general-message revision changed; reload before approving");
  validateGeneralMessage(current.type,current.value);
  checkIssue(current.ob_issue_no,current.type,current.value);
  if (current.approved_at) return current;
  const source = await db.prepare("SELECT source_yaml FROM general_messages WHERE id=?1").bind(id).first<{ source_yaml: string | null }>();
  const at = new Date().toISOString(), content = current.type === ANNEX_TYPE
    ? stringify(current.value, { lineWidth: 0, defaultKeyType: "QUOTE_DOUBLE" })
    : stringifyYamlPreservingSource(current.value, source?.source_yaml == null ? null : await unpackText(source.source_yaml));
  const packedContent = await packText(content), packedValue = await packJSON(current.value);
  const result = await run(db,[db.prepare(`UPDATE general_messages SET approved_at=?3,approved_by=?4,content_yaml=?5,updated_at=?3
    WHERE id=?1 AND revision=?2 AND approved_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM general_message_prs WHERE message_id=?1)
    AND NOT EXISTS (SELECT 1 FROM editions WHERE ob_issue_no=?6 AND status IN ('composing','staged','published'))`).bind(id,expected,at,actor.userId,packedContent,current.ob_issue_no),
    db.prepare(`INSERT INTO general_message_approvals (message_id,revision,value_json,content_yaml,approved_at,approved_by)
      SELECT ?1,?2,?3,?4,?5,?6 WHERE changes()=1`).bind(id,expected,packedValue,packedContent,at,actor.userId),
    ...await audit(db,actor,id,current.ob_issue_no,"general.message.approved",expected,at)]);
  if (!result[0]?.meta.changes) throw new ConflictError("revision changed or issue frozen before approval");
  return stored(db,id);
}
/** No reserialization after review: publisher consumes exactly the approved bytes. */
export async function generalMessageArtifact(db: D1Database, id: string, revision?: number): Promise<GeneralMessageArtifact> {
  const current = await stored(db,id);
  if (revision !== undefined && current.revision !== expectedRevision(revision)) throw new ConflictError("general-message revision changed");
  if (!current.approved_at || current.content_yaml === null) throw new ConflictError("administrator approval required before opening a review PR");
  const { className } = validateGeneralMessage(current.type,current.value);
  checkIssue(current.ob_issue_no,current.type,current.value);
  return { id:current.id, ob_issue_no:current.ob_issue_no,type:current.type,class_name:className,path:current.path,revision:current.revision,content:current.content_yaml };
}
