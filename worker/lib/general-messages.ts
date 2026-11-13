import { stringify } from "yaml";
import { generalBinding } from "../../src/lib/form/general.ts";
export { generalBinding, GENERAL_TYPES } from "../../src/lib/form/general.ts";
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
interface Stored extends Omit<GeneralMessage, "value"> { value_json: string }
export interface GeneralMessageArtifact {
  id: string; ob_issue_no: number; type: string; class_name: string; path: string; revision: number; content: string;
}
const staff = (s: Session | null) => requireRole(s, "itu-admin", "itu-editor");
export function validateGeneralMessage(type: unknown, value: unknown): { className: string; value: Record<string, unknown> } {
  let className: string;
  try { ({ className } = generalBinding(type)); } catch (error) { throw new InvalidError(error instanceof Error ? error.message : "invalid general-message type"); }
  if (type === "sanc") throw new InvalidError("SANC authoring unavailable: corpus GeneralSancs differs from service GeneralMessage dispatch; align the source model first");
  const errors = validateClass(className, value);
  if (!value || typeof value !== "object" || Array.isArray(value)) errors.push({ path: "", code: "type", message: "message must be an object" });
  else {
    const record = value as Record<string, unknown>;
    if (record.type !== type) errors.push({ path: "type", code: "type", message: "type must match the canonical message directory" });
    if (record._class !== undefined && record._class !== className) errors.push({ path: "_class", code: "type", message: "class must match the canonical message type" });
  }
  if (errors.length) throw new ValidationFailed(errors);
  return { className, value: value as Record<string, unknown> };
}
function checkIssue(no: number, value: Record<string, unknown>) {
  if (value.ob_issue_no !== String(no))
    throw new ValidationFailed([{ path: "ob_issue_no", code: "type", message: "ob_issue_no must match the canonical issue directory" }]);
}
function expectedRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new InvalidError("expected_revision must be a positive integer");
  return value;
}
function decode(row: Stored): GeneralMessage { const { value_json, ...rest } = row; return { ...rest, value: JSON.parse(value_json) }; }
async function stored(db: D1Database, id: string): Promise<GeneralMessage> {
  const row = await db.prepare("SELECT * FROM general_messages WHERE id=?1").bind(id).first<Stored>();
  if (!row) throw new NotFoundError("general-message draft not found");
  return decode(row);
}
export async function readGeneralMessage(db: D1Database, session: Session | null, id: string) { staff(session); return stored(db, id); }
export async function listGeneralMessages(db: D1Database, session: Session | null) {
  staff(session);
  return (await db.prepare("SELECT * FROM general_messages ORDER BY ob_issue_no DESC,path").all<Stored>()).results.map(decode);
}
async function audit(db: D1Database, actor: Session, id: string, no: number, action: string, revision: number, at: string) {
  return auditStatements(db, [{ at, actor_id: actor.userId, actor_kind: "user", action, subject_type: "edition", subject_id: String(no), submission_id: null, detail: { message_id: id, revision } }], { sql: "changes()=1", args: [] });
}
/** Sequence assignment is atomic within D1. The publisher must also reject an
 * existing canonical base path: this local DB is not an inventory of legacy Git. */
export async function createGeneralMessage(db: D1Database, session: Session | null, input: { ob_issue_no: unknown; type: unknown; value: unknown }) {
  const actor = staff(session), no = editionNo(input.ob_issue_no);
  const { className, value } = validateGeneralMessage(input.type, input.value);
  checkIssue(no,value);
  const type = input.type as string, binding = generalBinding(type), id = ulid(), at = new Date().toISOString();
  const singleton = binding.relativePath.startsWith("general/");
  const prefix = `ob-issues/${no}/${type}/`;
  const pathSql = singleton ? "?7" : `?7 || printf('%03d',coalesce((SELECT max(CAST(substr(path,length(?7)+1,3) AS INTEGER)) FROM general_messages WHERE ob_issue_no=?2 AND type=?3),0)+1) || '.yaml'`;
  const write = db.prepare(`INSERT INTO general_messages (id,ob_issue_no,type,class_name,path,value_json,revision,updated_at)
    SELECT ?1,?2,?3,?4,${pathSql},?5,1,?6
    WHERE NOT EXISTS (SELECT 1 FROM editions WHERE ob_issue_no=?2 AND status IN ('composing','staged','published'))
    AND (SELECT count(*) FROM general_messages WHERE ob_issue_no=?2 AND type=?3) < ?8
    ON CONFLICT(path) DO NOTHING`).bind(id,no,type,className,JSON.stringify(value),at,singleton ? `ob-issues/${no}/${binding.relativePath}` : prefix,singleton ? 1 : 999);
  const result = await run(db, [write, ...await audit(db,actor,id,no,"general.message.created",1,at)]);
  if (!result[0]?.meta.changes) throw new ConflictError("issue is frozen, singleton already exists, or message sequence exhausted");
  return stored(db,id);
}
export async function saveGeneralMessage(db: D1Database, session: Session | null, id: string, input: { expected_revision: unknown; value: unknown }) {
  const actor = staff(session), current = await stored(db,id), expected = expectedRevision(input.expected_revision);
  const { value } = validateGeneralMessage(current.type,input.value), at = new Date().toISOString();
  checkIssue(current.ob_issue_no,value);
  const result = await run(db,[db.prepare(`UPDATE general_messages SET value_json=?3,revision=revision+1,approved_at=NULL,approved_by=NULL,content_yaml=NULL,updated_at=?4
    WHERE id=?1 AND revision=?2 AND NOT EXISTS (SELECT 1 FROM general_message_prs WHERE message_id=?1)
    AND NOT EXISTS (SELECT 1 FROM editions WHERE ob_issue_no=?5 AND status IN ('composing','staged','published'))`).bind(id,expected,JSON.stringify(value),at,current.ob_issue_no),
    ...await audit(db,actor,id,current.ob_issue_no,"general.message.saved",expected+1,at)]);
  if (!result[0]?.meta.changes) throw new ConflictError("revision changed, issue frozen, or review PR reserved; reload before editing");
  return stored(db,id);
}
export async function approveGeneralMessage(db: D1Database, session: Session | null, id: string, revision: unknown) {
  const actor = requireRole(session,"itu-admin"), expected = expectedRevision(revision), current = await stored(db,id);
  if (current.revision !== expected) throw new ConflictError("general-message revision changed; reload before approving");
  validateGeneralMessage(current.type,current.value);
  checkIssue(current.ob_issue_no,current.value);
  if (current.approved_at) return current;
  const at = new Date().toISOString(), content = stringify(current.value,{lineWidth:0});
  const result = await run(db,[db.prepare(`UPDATE general_messages SET approved_at=?3,approved_by=?4,content_yaml=?5,updated_at=?3
    WHERE id=?1 AND revision=?2 AND approved_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM general_message_prs WHERE message_id=?1)
    AND NOT EXISTS (SELECT 1 FROM editions WHERE ob_issue_no=?6 AND status IN ('composing','staged','published'))`).bind(id,expected,at,actor.userId,content,current.ob_issue_no),
    db.prepare(`INSERT INTO general_message_approvals (message_id,revision,value_json,content_yaml,approved_at,approved_by)
      SELECT ?1,?2,?3,?4,?5,?6 WHERE changes()=1`).bind(id,expected,JSON.stringify(current.value),content,at,actor.userId),
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
  checkIssue(current.ob_issue_no,current.value);
  return { id:current.id, ob_issue_no:current.ob_issue_no,type:current.type,class_name:className,path:current.path,revision:current.revision,content:current.content_yaml };
}
