import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { approveGeneralMessage, createGeneralMessage, generalBinding, generalMessageArtifact, readGeneralMessage, saveGeneralMessage, validateGeneralMessage, GENERAL_TYPES } from "../worker/lib/general-messages.ts";
import { Forbidden } from "../worker/lib/authz.ts";
import { verifyChain } from "../worker/lib/audit.ts";
import { ConflictError, InvalidError } from "../worker/lib/membership.ts";
import { ValidationFailed } from "../worker/lib/submissions.ts";
import type { Session } from "../worker/lib/types.ts";
import { toFormState, toInstance } from "../src/lib/form/model.ts";
import { classify } from "../src/lib/form/corpus.ts";

// Runs the real SQL/migrations transactionally in SQLite. Host workerd/D1 tests remain separate.
function sqliteDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("migrations/0001_init.sql", "utf8"));
  sqlite.exec(readFileSync("migrations/0002_edition_metadata.sql", "utf8"));
  sqlite.exec(readFileSync("migrations/0003_general_messages.sql", "utf8"));
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
const admin: Session = { userId:"admin", roles:["itu-admin"], memberStateId:null };
const editor: Session = { userId:"editor", roles:["itu-editor"], memberStateId:null };
const member: Session = { userId:"member", roles:["member-submitter"], memberStateId:"A" };
const prose = {ob_issue_no:"1331",type:"misc_communications", text:"A notice", contents:"Line one\nLine two — café"};
let db: D1Database, sqlite: DatabaseSync;
beforeEach(() => { ({ db,sqlite } = sqliteDb()); });
afterEach(() => sqlite.close());
const create = (value: Record<string,unknown> = prose) => createGeneralMessage(db,editor,{ob_issue_no:1331,type:value.type,value});
describe("canonical general-message draft authoring", () => {
  it("derives every type/class/path from the existing corpus classifier", () => {
    for(const type of GENERAL_TYPES) {
      const binding = generalBinding(type);
      expect(classify(binding.relativePath,{type})).toEqual({className:binding.className,role:"general"});
    }
    expect(() => validateGeneralMessage("../meta",{})).toThrow(InvalidError);
    expect(() => generalBinding("misc_communications",1000)).toThrow();
    expect(() => validateGeneralMessage("sanc",{type:"sanc"})).toThrow(/SANC authoring unavailable/);
  });
  it.each(["running_annexes","approved_recommendations","telephone_service_2"])("round-trips real canonical %s fixture through form, DB and exact approved YAML",async type => {
    const value = parse(readFileSync(`test/fixtures/general-messages/${type}.yaml`,"utf8"));
    const {className} = validateGeneralMessage(type,value);
    expect(toInstance(toFormState(className,value).state)).toEqual(value);
    const saved = await create(value);
    const approved = await approveGeneralMessage(db,admin,saved.id,1);
    const artifact = await generalMessageArtifact(db,saved.id,1);
    expect(artifact.path).toBe(`ob-issues/1331/${generalBinding(type).relativePath}`);
    expect(artifact.content).toBe(approved.content_yaml);
    expect(parse(artifact.content)).toEqual(value);
    expect((await readGeneralMessage(db,editor,saved.id)).value).toEqual(value);
    expect(await verifyChain(db)).toBeNull();
  });
  it("authors readable plain prose, allocates safe sequences, and emits the class itself", async () => {
    const first = await create(), second = await create();
    expect(first.path).toBe("ob-issues/1331/misc_communications/001.yaml");
    expect(second.path).toBe("ob-issues/1331/misc_communications/002.yaml");
    await expect(generalMessageArtifact(db,first.id)).rejects.toBeInstanceOf(ConflictError);
    await approveGeneralMessage(db,admin,first.id,1);
    expect(parse((await generalMessageArtifact(db,first.id)).content)).toEqual(prose);
    expect(sqlite.prepare("SELECT count(*) n FROM submissions").get()?.n).toBe(0);
    expect(sqlite.prepare("SELECT count(*) n FROM editions").get()?.n).toBe(0);
  });
  it("requires staff for create/read and administrators for approval",async () => {
    for(const session of [null,member]) await expect(createGeneralMessage(db,session,{ob_issue_no:1331,type:prose.type,value:prose})).rejects.toBeInstanceOf(Forbidden);
    const saved = await create();
    await expect(readGeneralMessage(db,member,saved.id)).rejects.toBeInstanceOf(Forbidden);
    await expect(approveGeneralMessage(db,editor,saved.id,1)).rejects.toBeInstanceOf(Forbidden);
    expect(await readGeneralMessage(db,admin,saved.id)).toEqual(saved);
  });
  it.each([{...prose,type:"custom"},{...prose,_class:"GeneralCustom"},{...prose,ob_issue_no:"1400"},{...prose,contents:42},{...prose,extra:"unexpected"}])("rejects malformed ontology values and mismatched class/type without writes",async value => {
    await expect(createGeneralMessage(db,admin,{ob_issue_no:1331,type:prose.type,value})).rejects.toBeInstanceOf(ValidationFailed);
    expect(sqlite.prepare("SELECT count(*) n FROM general_messages").get()?.n).toBe(0);
    expect(sqlite.prepare("SELECT count(*) n FROM audit_log").get()?.n).toBe(0);
  });
  it("rejects stale edits/approvals and retains prior approved snapshots when editing",async () => {
    const first = await create();
    const approved = await approveGeneralMessage(db,admin,first.id,1);
    const second = await saveGeneralMessage(db,editor,first.id,{expected_revision:1,value:{...prose,text:"Edited"}});
    expect(second).toMatchObject({revision:2,approved_at:null,content_yaml:null});
    expect(sqlite.prepare("SELECT content_yaml FROM general_message_approvals WHERE message_id=? AND revision=1").get(first.id)?.content_yaml).toBe(approved.content_yaml);
    await expect(saveGeneralMessage(db,editor,first.id,{expected_revision:1,value:prose})).rejects.toBeInstanceOf(ConflictError);
    await expect(approveGeneralMessage(db,admin,first.id,1)).rejects.toBeInstanceOf(ConflictError);
    await expect(generalMessageArtifact(db,first.id,2)).rejects.toBeInstanceOf(ConflictError);
    expect(await readGeneralMessage(db,admin,first.id)).toEqual(second);
    expect(await verifyChain(db)).toBeNull();
  });
  it("reserving reviewed bytes locks edits and preserves opaque multilingual documents",async () => {
    const value = {ob_issue_no:"1331",type:prose.type,contents:{en:{type:"doc",content:[{type:"paragraph",content:[{type:"text",text:"Legacy"}]}]},fr:"Bonjour"}};
    const first = await create(value); await approveGeneralMessage(db,admin,first.id,1);
    const artifact = await generalMessageArtifact(db,first.id,1);
    sqlite.prepare("INSERT INTO general_message_prs(message_id,revision,repo,branch,path,content_yaml) VALUES (?,1,'ituob/data','rt-msg',?,?)").run(first.id,artifact.path,artifact.content);
    await expect(saveGeneralMessage(db,editor,first.id,{expected_revision:1,value:prose})).rejects.toBeInstanceOf(ConflictError);
    expect(await generalMessageArtifact(db,first.id,1)).toEqual(artifact);
    expect(parse(artifact.content)).toEqual(value);
  });
  it("refuses duplicate singletons without touching the original or its audit",async () => {
    const value={ob_issue_no:"1331",type:"running_annexes",extra_links:["M1400_ICC"]}; const first=await create(value);
    await expect(create(value)).rejects.toBeInstanceOf(ConflictError);
    expect(await readGeneralMessage(db,admin,first.id)).toEqual(first);
    expect(sqlite.prepare("SELECT count(*) n FROM audit_log").get()?.n).toBe(1);
  });
  it.each(["composing","staged","published"])("freezes %s issues",async status => {
    const saved=await create(); sqlite.prepare("INSERT INTO editions(ob_issue_no,status,created_at) VALUES (1331,?,'now')").run(status);
    await expect(create()).rejects.toBeInstanceOf(ConflictError);
    await expect(saveGeneralMessage(db,editor,saved.id,{expected_revision:1,value:prose})).rejects.toBeInstanceOf(ConflictError);
    await expect(approveGeneralMessage(db,admin,saved.id,1)).rejects.toBeInstanceOf(ConflictError);
    expect(await readGeneralMessage(db,admin,saved.id)).toEqual(saved);
  });
  it("rolls back state when audit append fails",async () => {
    sqlite.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");
    await expect(create()).rejects.toThrow(); expect(sqlite.prepare("SELECT count(*) n FROM general_messages").get()?.n).toBe(0);
  });
});
