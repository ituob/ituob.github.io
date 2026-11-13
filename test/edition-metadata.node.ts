import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { metadataArtifact, readMetadata, saveMetadata, scheduleMetadata, validateMetadata } from "../worker/lib/edition-metadata.ts";
import { Forbidden } from "../worker/lib/authz.ts";
import { verifyChain } from "../worker/lib/audit.ts";
import { ConflictError } from "../worker/lib/membership.ts";
import { ValidationFailed } from "../worker/lib/submissions.ts";
import type { Session } from "../worker/lib/types.ts";
import { toFormState, toInstance } from "../src/lib/form/model.ts";

// Runs the real SQL/migrations transactionally in SQLite. Host workerd/D1 tests remain separate.
function sqliteDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("migrations/0001_init.sql", "utf8"));
  sqlite.exec(readFileSync("migrations/0002_edition_metadata.sql", "utf8"));
  sqlite.exec("INSERT INTO users(id,email,created_at) VALUES ('admin','admin@example.test','2026-01-01'),('editor','editor@example.test','2026-01-01')");
  class Statement {
    constructor(readonly sql: string, readonly args: unknown[] = []) {}
    bind(...args: unknown[]) { return new Statement(this.sql, args); }
    private prepare() {
      const args: unknown[] = [];
      const sql = this.sql.replace(/\?(\d+)/g, (_, n) => { args.push(this.args[Number(n) - 1]); return "?"; });
      return { stmt: sqlite.prepare(sql), args: args as (string | number | null)[] };
    }
    async first() { const { stmt, args } = this.prepare(); return stmt.get(...args) ?? null; }
    async all() { const { stmt, args } = this.prepare(); return { results: stmt.all(...args) }; }
    async run() { const { stmt, args } = this.prepare(); return { success: true, meta: { changes: Number(stmt.run(...args).changes) } }; }
  }
  const db = {
    prepare: (sql: string) => new Statement(sql),
    batch: async (statements: Statement[]) => {
      sqlite.exec("BEGIN");
      try { const result = []; for (const s of statements) result.push(await s.run()); sqlite.exec("COMMIT"); return result; }
      catch (e) { sqlite.exec("ROLLBACK"); throw e; }
    },
  } as unknown as D1Database;
  return { db, sqlite };
}
const admin: Session = { userId: "admin", roles: ["itu-admin"], memberStateId: null };
const editor: Session = { userId: "editor", roles: ["itu-editor"], memberStateId: null };
const member: Session = { userId: "member", roles: ["member-submitter"], memberStateId: "A" };
const metadata = { id: 1400, publication_date: "2027-02-01", cutoff_date: "2027-01-20", incomplete: false, issn: "1564-5223", languages: { en: true, fr: false },
  authors: [{ name: "TSB", address: "Place des Nations\nGenève", contacts: [{ type: "email", data: "tsb@itu.int", recommended: true }] }] };
let db: D1Database, sqlite: DatabaseSync;
beforeEach(() => { ({ db, sqlite } = sqliteDb()); });
describe("edition metadata schema and scheduling", () => {
  it("preserves all nested metadata through the public schema form model", () => {
    expect(toInstance(toFormState("IssueMetadata", metadata).state)).toEqual(metadata);
  });
  it("has no existing draft and requires staff even for reads", async () => {
    expect(await readMetadata(db, editor, 1400)).toBeNull();
    for (const session of [null, member]) {
      await expect(readMetadata(db, session, 1400)).rejects.toBeInstanceOf(Forbidden);
      await expect(saveMetadata(db, session, 1400, { metadata, expected_revision: 0 })).rejects.toBeInstanceOf(Forbidden);
    }
    expect(sqlite.prepare("SELECT count(*) AS n FROM edition_metadata").get()?.n).toBe(0);
  });
  it.each([
    { ...metadata, authors: [{ contacts: [{ type: 7 }] }] },
    { ...metadata, languages: [] }, { ...metadata, unexpected: true }, { ...metadata, id: "1400" },
    { ...metadata, publication_date: "2027-02-29" }, { ...metadata, cutoff_date: "2027-02-30" },
    { ...metadata, publication_date: "2027-02-01T12:00:00Z" }, { ...metadata, cutoff_date: "2027-02-02" },
  ])("refuses invalid metadata without persisting it", async value => {
    await expect(saveMetadata(db, admin, 1400, { metadata: value, expected_revision: 0 })).rejects.toBeInstanceOf(ValidationFailed);
    expect(await readMetadata(db, admin, 1400)).toBeNull();
    expect(sqlite.prepare("SELECT count(*) AS n FROM audit_log").get()?.n).toBe(0);
  });
  it("allows incomplete drafts but requires both dates to schedule", async () => {
    const saved = await saveMetadata(db, editor, 1400, { metadata: { id: 1400 }, expected_revision: 0 });
    await expect(scheduleMetadata(db, admin, 1400, saved.revision)).rejects.toBeInstanceOf(ValidationFailed);
    expect(await readMetadata(db, editor, 1400)).toEqual(saved);
    expect(validateMetadata(1400, { ...metadata, publication_date: "2028-02-29", cutoff_date: "2028-02-29" }, true)).toBeTruthy();
  });
  it("durably preserves nested optional values, schedules dates and emits exact reviewed-PR content", async () => {
    const saved = await saveMetadata(db, editor, 1400, { metadata, expected_revision: 0 });
    expect((await readMetadata(db, admin, 1400))?.metadata).toEqual(metadata);
    await expect(metadataArtifact(db, 1400)).rejects.toBeInstanceOf(ConflictError);
    await expect(scheduleMetadata(db, editor, 1400, 1)).rejects.toBeInstanceOf(Forbidden);
    const scheduled = await scheduleMetadata(db, admin, 1400, saved.revision);
    expect(scheduled.scheduled_at).toBeTruthy(); expect(scheduled.revision).toBe(2);
    expect(await scheduleMetadata(db, admin, 1400, 2)).toEqual(scheduled);
    const artifact = await metadataArtifact(db, 1400, 2);
    expect(artifact.path).toBe("ob-issues/1400/meta.yaml"); expect(parse(artifact.content)).toEqual(metadata);
    expect(artifact).toMatchObject({ revision: 2, publication_date: metadata.publication_date, cutoff_date: metadata.cutoff_date });
    expect(sqlite.prepare("SELECT count(*) AS n FROM editions").get()?.n).toBe(0);
    expect(await verifyChain(db)).toBeNull();
  });
  it("rejects stale saves/schedules, preserving metadata and its audit trail", async () => {
    const first = await saveMetadata(db, admin, 1400, { metadata, expected_revision: 0 });
    for (const expected_revision of [0, 99]) await expect(saveMetadata(db, editor, 1400, { metadata: { id: 1400 }, expected_revision })).rejects.toBeInstanceOf(ConflictError);
    await expect(scheduleMetadata(db, admin, 1400, 0)).rejects.toBeInstanceOf(ConflictError);
    expect(await readMetadata(db, admin, 1400)).toEqual(first);
    expect(sqlite.prepare("SELECT count(*) AS n FROM audit_log").get()?.n).toBe(1);
  });
  it("edits clear scheduling and invalidate old artifact revisions", async () => {
    await saveMetadata(db, admin, 1400, { metadata, expected_revision: 0 });
    await scheduleMetadata(db, admin, 1400, 1);
    const next = await saveMetadata(db, editor, 1400, { metadata: { ...metadata, cutoff_date: "2027-01-21" }, expected_revision: 2 });
    expect(next).toMatchObject({ revision: 3, scheduled_at: null });
    await expect(metadataArtifact(db, 1400, 2)).rejects.toBeInstanceOf(ConflictError);
    await expect(metadataArtifact(db, 1400, 3)).rejects.toBeInstanceOf(ConflictError);
    expect(await verifyChain(db)).toBeNull();
  });
  it("schedules multiple future issues independently and uses deterministic YAML keys", async () => {
    for (const no of [1400, 1401]) {
      await saveMetadata(db, admin, no, { metadata: { ...metadata, id: no }, expected_revision: 0 });
      await scheduleMetadata(db, admin, no, 1);
    }
    const first = await metadataArtifact(db, 1400);
    await saveMetadata(db, admin, 1400, { metadata: Object.fromEntries(Object.entries(metadata).reverse()), expected_revision: 2 });
    await scheduleMetadata(db, admin, 1400, 3);
    expect((await metadataArtifact(db, 1400)).content).toBe(first.content);
    expect((await metadataArtifact(db, 1401)).path).toBe("ob-issues/1401/meta.yaml");
  });
  it.each(["composing", "staged", "published"])("preserves metadata of a %s edition", async status => {
    const saved = await saveMetadata(db, admin, 1400, { metadata, expected_revision: 0 });
    sqlite.prepare("INSERT INTO editions(ob_issue_no,status,created_at) VALUES (1400,?, '2026-01-01')").run(status);
    await expect(saveMetadata(db, admin, 1400, { metadata: { id: 1400 }, expected_revision: 1 })).rejects.toBeInstanceOf(ConflictError);
    await expect(scheduleMetadata(db, admin, 1400, 1)).rejects.toBeInstanceOf(ConflictError);
    expect(await readMetadata(db, admin, 1400)).toEqual(saved);
    expect(sqlite.prepare("SELECT count(*) AS n FROM audit_log").get()?.n).toBe(1);
  });
  it("rolls metadata back if audit insertion fails", async () => {
    sqlite.exec("CREATE TRIGGER reject_metadata_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
    await expect(saveMetadata(db, admin, 1400, { metadata, expected_revision: 0 })).rejects.toThrow();
    expect(await readMetadata(db, admin, 1400)).toBeNull();
  });
  it("preserves a reserved PR revision even before its GitHub response is recorded", async () => {
    await saveMetadata(db, admin, 1400, { metadata, expected_revision: 0 });
    const scheduled = await scheduleMetadata(db, admin, 1400, 1);
    const artifact = await metadataArtifact(db, 1400, scheduled.revision);
    sqlite.prepare("INSERT INTO edition_metadata_prs(ob_issue_no,revision,repo,branch,path,content_yaml) VALUES (1400,2,'ituob/itu-ob-data','rt-edition-1400-meta',?,?)").run(artifact.path, artifact.content);
    await expect(saveMetadata(db, admin, 1400, { metadata: { id: 1400 }, expected_revision: 2 })).rejects.toBeInstanceOf(ConflictError);
    expect(await readMetadata(db, admin, 1400)).toEqual(scheduled);
    expect(await metadataArtifact(db, 1400, 2)).toEqual(artifact);
  });
});
