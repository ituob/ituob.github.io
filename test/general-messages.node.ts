import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { approveGeneralMessage, createGeneralMessage, deleteGeneralMessage, importGeneralMessage, generalBinding, generalMessageArtifact, readGeneralMessage, saveGeneralMessage, validateGeneralMessage, GENERAL_TYPES } from "../worker/lib/general-messages.ts";
import { FakeRepoReader } from "../worker/lib/repo-reader.ts";
import { NotFoundError } from "../worker/lib/membership.ts";
import { Forbidden } from "../worker/lib/authz.ts";
import { verifyChain } from "../worker/lib/audit.ts";
import { ConflictError, InvalidError } from "../worker/lib/membership.ts";
import { ValidationFailed } from "../worker/lib/submissions.ts";
import type { Session } from "../worker/lib/types.ts";
import { toFormState, toInstance } from "../src/lib/form/model.ts";
import { classify } from "../src/lib/form/corpus.ts";
import { MAX_STORED_BYTES, packJSON, packText, unpackJSON, unpackText } from "../worker/lib/general-message-storage.ts";

// Runs the real SQL/migrations transactionally in SQLite. Host workerd/D1 tests remain separate.
function sqliteDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("migrations/0001_init.sql", "utf8"));
  sqlite.exec(readFileSync("migrations/0002_edition_metadata.sql", "utf8"));
  sqlite.exec(readFileSync("migrations/0003_general_messages.sql", "utf8"));
  sqlite.exec(readFileSync("migrations/0005_general_message_source.sql", "utf8"));
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
  it("preserves compressed SQLite TEXT envelopes without truncation", async () => {
    const source = "Telephone café notice. ".repeat(10_000);
    const value = { type: "custom", contents: source };
    const packed = await packText(source), packedJSON = await packJSON(value);
    sqlite.exec("CREATE TABLE storage_probe (content TEXT, value_json TEXT CHECK(json_valid(value_json)))");
    sqlite.prepare("INSERT INTO storage_probe(content,value_json) VALUES (?,?)").run(packed, packedJSON);
    const raw = sqlite.prepare("SELECT content,value_json FROM storage_probe").get() as { content: string; value_json: string };
    expect(raw.content === packed, "SQLite must return the entire compressed TEXT envelope").toBe(true);
    expect(await unpackText(raw.content) === source, "decoded SQLite text must preserve every byte").toBe(true);
    expect(await unpackJSON(raw.value_json)).toEqual(value);
  });
  it("stores the largest real telephone corpus source and approval within the D1 column budget", async () => {
    const path = "ob-issues/1252/telephone_service_2/001.yaml";
    const source = readFileSync(join(process.env.OB_DATA_ROOT ?? "data-ob", path), "utf8");
    expect(Buffer.byteLength(source)).toBeGreaterThan(7_000_000);
    const draft = await importGeneralMessage(db, editor, { ob_issue_no: 1252, path }, new FakeRepoReader({ [`o/r:${path}`]: source }), "o/r");
    const saved = await saveGeneralMessage(db, editor, draft.id, { expected_revision: 1, value: toInstance(toFormState(draft.class_name, draft.value).state) });
    await approveGeneralMessage(db, admin, saved.id, saved.revision);
    const raw = sqlite.prepare("SELECT value_json,source_yaml,content_yaml FROM general_messages WHERE id=?").get(saved.id) as Record<string, string>;
    for (const text of Object.values(raw)) expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_STORED_BYTES);
    expect(await unpackText(raw.source_yaml) === source, `${path}: stored source bytes differ`).toBe(true);
    expect((await generalMessageArtifact(db, saved.id)).content === source, `${path}: approved bytes differ`).toBe(true);
    expect(sqlite.prepare("SELECT json_valid(value_json) valid FROM general_messages WHERE id=?").get(saved.id)?.valid).toBe(1);
  }, 900_000);
  it.each(["sanc", "telephone_service_2"])("keeps imported %s YAML byte-identical through form save and approval", async type => {
    const source = "# Preserve original formatting\n" + readFileSync(`test/fixtures/general-messages/${type}.yaml`, "utf8").replace(/^ob_issue_no:.*\n/gm, "") + "\nob_issue_no: '1331'\n";
    const path = `ob-issues/1331/${type}/001.yaml`;
    const reader = new FakeRepoReader({ [`o/r:${path}`]: source });
    const imported = await importGeneralMessage(db, editor, { ob_issue_no: 1331, path }, reader, "o/r");
    const value = toInstance(toFormState(imported.class_name, imported.value).state);
    const saved = await saveGeneralMessage(db, editor, imported.id, { expected_revision: 1, value });
    await approveGeneralMessage(db, admin, saved.id, saved.revision);
    expect((await generalMessageArtifact(db, saved.id)).content).toBe(source);
    const changed = await saveGeneralMessage(db, editor, saved.id, { expected_revision: saved.revision, value: { ...saved.value, ob_issue_no: "1331", ...(type === "sanc" ? { notes: "Changed notice" } : { text: "Changed notice" }) } });
    await approveGeneralMessage(db, admin, changed.id, changed.revision);
    expect((await generalMessageArtifact(db, changed.id)).content).not.toBe(source);
    expect(parse((await generalMessageArtifact(db, changed.id)).content)).toEqual(changed.value);
    const reverted = await saveGeneralMessage(db, editor, changed.id, { expected_revision: changed.revision, value });
    await approveGeneralMessage(db, admin, reverted.id, reverted.revision);
    expect((await generalMessageArtifact(db, reverted.id)).content).toBe(source);
    expect(await verifyChain(db)).toBeNull();
  });
  it("derives every type/class/path from the existing corpus classifier", () => {
    for(const type of GENERAL_TYPES) {
      const binding = generalBinding(type);
      expect(classify(binding.relativePath,{type})).toEqual({className:binding.className,role:"general"});
    }
    expect(() => validateGeneralMessage("../meta",{})).toThrow(InvalidError);
    expect(() => generalBinding("misc_communications",1000)).toThrow();
    expect(validateGeneralMessage("sanc",{type:"sanc"}).className).toBe("GeneralSancs");
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
  it("preserves a real legacy SANC document alongside typed authored rows and notes", async () => {
    const legacy = parse(readFileSync("test/fixtures/general-messages/sanc.yaml","utf8"));
    const value = {...legacy, ob_issue_no:"1331", items:[{country:"Example",sanc:"7-001"}], notes:"Retain note"};
    const saved = await create(value);
    expect(saved.class_name).toBe("GeneralSancs");
    expect(saved.path).toBe("ob-issues/1331/sanc/001.yaml");
    await approveGeneralMessage(db,admin,saved.id,1);
    expect(parse((await generalMessageArtifact(db,saved.id)).content)).toEqual(value);
    expect(legacy.contents).toEqual(saved.value.contents);
  });
  it("authors scalar telephone communication prose with exact approved wire values", async () => {
    const value = {type:"telephone_service_2",ob_issue_no:"1331",contents:[{country_name:{en:"Example"},communications:[{contents:"Readable telephone notice"},{contents:{en:"English",fr:"Français",es:"Español",ar:"العربية",ru:"Русский",zh:"中文"}}]}]};
    const saved = await create(value);
    await approveGeneralMessage(db,admin,saved.id,1);
    expect(parse((await generalMessageArtifact(db,saved.id)).content)).toEqual(value);
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
  it("deletes an unreviewed draft with audit, and refuses stale, approved or non-staff deletes", async () => {
    const draft = await create();
    await expect(deleteGeneralMessage(db,member,draft.id,1)).rejects.toThrow(Forbidden);
    await expect(deleteGeneralMessage(db,editor,draft.id,2)).rejects.toThrow(ConflictError);
    expect(await deleteGeneralMessage(db,editor,draft.id,1)).toEqual({id:draft.id,deleted:true});
    await expect(readGeneralMessage(db,editor,draft.id)).rejects.toThrow();
    expect((sqlite.prepare("SELECT count(*) n FROM audit_log WHERE action='general.message.deleted'").get() as {n:number}).n).toBe(1);
    expect(await verifyChain(db)).toBeNull();
    const approved = await create();
    await approveGeneralMessage(db,admin,approved.id,1);
    await expect(deleteGeneralMessage(db,admin,approved.id,1)).rejects.toThrow(ConflictError);
    expect((await readGeneralMessage(db,editor,approved.id)).id).toBe(approved.id);
  });
  it("deletes an approved-then-edited draft: the standing approval is gone, the stale snapshot goes with it", async () => {
    const draft = await create();
    await approveGeneralMessage(db,admin,draft.id,1);
    const edited = await saveGeneralMessage(db,editor,draft.id,{expected_revision:1,value:{...draft.value,text:"Edited after approval"}});
    expect(edited).toMatchObject({revision:2,approved_at:null});
    expect(sqlite.prepare("SELECT count(*) n FROM general_message_approvals WHERE message_id=?").get(draft.id)?.n).toBe(1);
    expect(await deleteGeneralMessage(db,editor,draft.id,2)).toEqual({id:draft.id,deleted:true});
    expect(sqlite.prepare("SELECT count(*) n FROM general_message_approvals WHERE message_id=?").get(draft.id)?.n).toBe(0);
    expect(sqlite.prepare("SELECT count(*) n FROM general_messages WHERE id=?").get(draft.id)?.n).toBe(0);
    // Re-approved at the new revision it is protected again, and a refused delete removes nothing.
    const again = await create();
    await approveGeneralMessage(db,admin,again.id,1);
    await expect(deleteGeneralMessage(db,admin,again.id,1)).rejects.toThrow(ConflictError);
    expect(sqlite.prepare("SELECT count(*) n FROM general_message_approvals WHERE message_id=?").get(again.id)?.n).toBe(1);
  });
  it("imports only the canonical path of a type, and decides that before reading the repository", async () => {
    const reader = new FakeRepoReader({
      "o/r:ob-issues/5/approved_recommendations/001.yaml": "type: approved_recommendations\nob_issue_no: '5'\ncontents: {en: hello}\n",
      "o/r:ob-issues/5/general/approved_recommendations.yaml": "type: approved_recommendations\nob_issue_no: '5'\ncontents: {en: hello}\n",
      "o/r:ob-issues/5/general/misc_communications.yaml": "type: misc_communications\nob_issue_no: '5'\ntext: x\n",
    });
    for (const bad of ["ob-issues/5/approved_recommendations/001.yaml","ob-issues/5/running_annexes/002.yaml","ob-issues/5/general/misc_communications.yaml","ob-issues/5/misc_communications/000.yaml","ob-issues/5/general/001.yaml","ob-issues/5/meta/001.yaml","ob-issues/5/general/nope.yaml"])
      await expect(importGeneralMessage(db,editor,{ob_issue_no:5,path:bad},reader,"o/r"),bad).rejects.toThrow(InvalidError);
    expect(reader.reads).toEqual([]);
    expect((await importGeneralMessage(db,editor,{ob_issue_no:5,path:"ob-issues/5/general/approved_recommendations.yaml"},reader,"o/r")).path).toBe("ob-issues/5/general/approved_recommendations.yaml");
    expect(reader.reads).toEqual(["o/r:ob-issues/5/general/approved_recommendations.yaml"]);
  });
  it("opens an existing remote record as a draft at its own path, and refuses bad paths, misses and duplicates", async () => {
    const path = "ob-issues/1331/misc_communications/004.yaml";
    const reader = new FakeRepoReader({ [`o/r:${path}`]: "type: misc_communications\nob_issue_no: '1331'\ntext: Old notice\n" });
    const draft = await importGeneralMessage(db,editor,{ob_issue_no:1331,path},reader,"o/r");
    expect(draft).toMatchObject({path,type:"misc_communications",revision:1,value:{text:"Old notice"}});
    const saved = await saveGeneralMessage(db,editor,draft.id,{expected_revision:1,value:{...draft.value,text:"New notice"}});
    expect(saved.revision).toBe(2);
    await approveGeneralMessage(db,admin,draft.id,2);
    expect(await generalMessageArtifact(db,draft.id)).toMatchObject({path,content:expect.stringContaining("New notice")});
    await expect(importGeneralMessage(db,editor,{ob_issue_no:1331,path},reader,"o/r")).rejects.toThrow(ConflictError);
    await expect(importGeneralMessage(db,editor,{ob_issue_no:1331,path:"ob-issues/1331/misc_communications/005.yaml"},reader,"o/r")).rejects.toThrow(NotFoundError);
    for (const bad of ["ob-issues/1332/misc_communications/004.yaml","../x.yaml","ob-issues/1331/meta.yaml"]) await expect(importGeneralMessage(db,editor,{ob_issue_no:1331,path:bad},reader,"o/r")).rejects.toThrow(InvalidError);
    await expect(importGeneralMessage(db,member,{ob_issue_no:1331,path},reader,"o/r")).rejects.toThrow(Forbidden);
    reader.set("o/r","ob-issues/1331/misc_communications/006.yaml","type: misc_communications\ntext: no issue number\n");
    await expect(importGeneralMessage(db,editor,{ob_issue_no:1331,path:"ob-issues/1331/misc_communications/006.yaml"},reader,"o/r")).rejects.toThrow(ValidationFailed);
  });
});

describe("complete general-message corpus through the Worker draft lifecycle", () => {
  it.each(["sanc", "telephone_service_2", "custom", "mid"])("imports, form-saves and approves every %s record without changing bytes", async type => {
    const root = process.env.OB_DATA_ROOT ?? "data-ob";
    const issues = join(root, "ob-issues");
    expect(existsSync(issues), "OB_DATA_ROOT must provide the real corpus").toBe(true);
    let count = 0;
    for (const issue of readdirSync(issues)) {
      const directory = join(issues, issue, type);
      if (!existsSync(directory)) continue;
      for (const file of readdirSync(directory).filter(name => name.endsWith(".yaml"))) {
        const source = readFileSync(join(directory, file), "utf8");
        const path = `ob-issues/${issue}/${type}/${file}`;
        const imported = await importGeneralMessage(db, editor, { ob_issue_no: Number(issue), path }, new FakeRepoReader({ [`o/r:${path}`]: source }), "o/r");
        const value = toInstance(toFormState(imported.class_name, imported.value).state);
        const saved = await saveGeneralMessage(db, editor, imported.id, { expected_revision: 1, value });
        await approveGeneralMessage(db, admin, saved.id, saved.revision);
        expect((await generalMessageArtifact(db, saved.id)).content === source, `${path}: approved bytes differ`).toBe(true);
        count++;
      }
    }
    expect(count).toBeGreaterThan(0);
    console.info(`Worker byte-identical ${type}: ${count} records`);
    expect(await verifyChain(db)).toBeNull();
  }, 900_000);
});
