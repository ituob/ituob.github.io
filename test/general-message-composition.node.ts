import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { approveGeneralMessage, createGeneralMessage, generalMessageArtifact, saveGeneralMessage } from "../worker/lib/general-messages.ts";
import { openEdition, publishEdition, readEdition, removeItem } from "../worker/lib/composer.ts";
import { generalSelection, requireGeneralReviews } from "../worker/lib/general-message-composition.ts";
import { metadataArtifact, saveMetadata, scheduleMetadata } from "../worker/lib/edition-metadata.ts";
import { FakePatchPublisher } from "../worker/lib/publisher.ts";
import { verifyChain } from "../worker/lib/audit.ts";
import { ConflictError } from "../worker/lib/membership.ts";
import { UpstreamError } from "../worker/lib/submissions.ts";
import { Forbidden } from "../worker/lib/authz.ts";
import type { Session } from "../worker/lib/types.ts";
import { canPublishEdition, generalMessageStatus } from "../src/lib/discussion-client.ts";

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
const admin: Session={userId:"admin",roles:["itu-admin"],memberStateId:null};
const editor: Session={userId:"editor",roles:["itu-editor"],memberStateId:null};
let db:D1Database,sqlite:DatabaseSync,fake:FakePatchPublisher;
beforeEach(()=>{({db,sqlite}=sqliteDb());fake=new FakePatchPublisher();});
afterEach(()=>sqlite.close());
const value={type:"misc_communications",ob_issue_no:"1400",contents:"Authored notice"};
async function general(stage:"draft"|"approved"|"reserved"|"open"|"merged"="merged",no=1400) {
  const saved=await createGeneralMessage(db,editor,{ob_issue_no:no,type:value.type,value:{...value,ob_issue_no:String(no)}});
  if(stage==="draft")return saved;
  await approveGeneralMessage(db,admin,saved.id,1);
  if(stage==="approved")return saved;
  const artifact=await generalMessageArtifact(db,saved.id,1),branch=`rt-msg-${no}-${saved.id}-r1`;
  const pr=stage==="reserved"?null:await fake.openGeneralMessagePr({repo:"ituob/data",branch,path:artifact.path,content:artifact.content,edition:no,revision:1,messageId:saved.id,messageType:value.type,title:"General",body:"Review",idempotencyKey:branch});
  sqlite.prepare("INSERT INTO general_message_prs(message_id,revision,repo,branch,path,content_yaml,pr_number,commit_sha,pr_url) VALUES (?,1,'ituob/data',?,?,?,?,?,?)")
    .run(saved.id,branch,artifact.path,artifact.content,pr?.prNumber??null,pr?.commitSha??null,pr?.url??null);
  if(stage==="merged")fake.mergePr(pr!.prNumber,"g".repeat(40));
  return saved;
}
async function register(id="REGISTER",no=1400) {
  await openEdition(db,admin,no);
  sqlite.prepare("INSERT INTO submissions(id,proposer_id,affiliation_kind,register_id,slug,action_type,state,target_edition,seq,created_at,updated_at) VALUES (?,'editor','itu','E118_IIN','e118-iin','ADD','scheduled',?,1,'now','now')").run(id,no);
  sqlite.prepare("INSERT INTO submission_prs(submission_id,rev,repo,branch,path,content_yaml,content_sha,idempotency_key,pr_state,merge_sha) VALUES (?,1,'ituob/data',?,'path','yaml','sha','key','merged',?)").run(id,`rt-sub-${id}`,"r".repeat(40));
  sqlite.prepare("INSERT INTO edition_items(ob_issue_no,submission_id,position) VALUES (?,?,1)").run(no,id);
  sqlite.prepare("UPDATE editions SET status='composing' WHERE ob_issue_no=?").run(no);
  return id;
}
const edition=()=>sqlite.prepare("SELECT * FROM editions WHERE ob_issue_no=1400").get()!;
const state=(id:string)=>sqlite.prepare("SELECT state FROM submissions WHERE id=?").get(id)?.state;
describe("general-message edition composition",()=>{
  it("publishes a general-only open edition with its merged review in frozen ancestry",async()=>{
    const message=await general();await openEdition(db,admin,1400);
    const result=await publishEdition(db,admin,1400,fake);
    expect(result.edition.status).toBe("published");expect(result.edition.freeze_sha).toBeTruthy();expect(result.published).toEqual([]);
    expect(fake.pinRequests[0].items).toEqual([{submissionId:`general-${message.id}-r1`,mergeSha:"g".repeat(40)}]);
    const detail=await readEdition(db,admin,1400);expect(detail.items).toEqual([]);
    expect(detail.general_messages).toMatchObject([{id:message.id,status:"published",content_yaml:expect.stringContaining("Authored notice")}]);
    expect(await verifyChain(db)).toBeNull();
  });
  it("requires every general review to be merged even when register content is ready",async()=>{
    await general();await general("open");const id=await register();
    await expect(publishEdition(db,admin,1400,fake)).rejects.toThrow(/general message .* must be merged/);
    expect(fake.pinRequests).toHaveLength(0);expect(state(id)).toBe("scheduled");expect(edition().status).toBe("composing");
    expect(edition().published_at).toBeNull();expect(await verifyChain(db)).toBeNull();
  });
  it.each(["draft","approved","reserved"] as const)("refuses %s general records before an upstream request and keeps open drafts editable",async stage=>{
    const message=await general(stage);await openEdition(db,admin,1400);
    const read=vi.spyOn(fake,"getGeneralMessagePullRequest");
    await expect(publishEdition(db,admin,1400,fake)).rejects.toBeInstanceOf(ConflictError);
    expect(read).not.toHaveBeenCalled();expect(fake.pinRequests).toHaveLength(0);expect(edition().status).toBe("open");
    if(stage==="draft")expect((await saveGeneralMessage(db,editor,message.id,{expected_revision:1,value:{...value,contents:"Corrected"}})).revision).toBe(2);
  });
  it("joins general, register and newly authored merged metadata ancestry",async()=>{
    const message=await general();
    await saveMetadata(db,admin,1400,{metadata:{id:1400,publication_date:"2027-01-01",cutoff_date:"2026-12-31"},expected_revision:0});
    await scheduleMetadata(db,admin,1400,1);const artifact=await metadataArtifact(db,1400,2);
    const metadataPr = await fake.openMetadataPr({ repo:"ituob/data",branch:"rt-meta-1400-r2",path:artifact.path,content:artifact.content,edition:1400,revision:2,title:"Metadata",body:"Review",idempotencyKey:"meta-1400-r2" });
    sqlite.prepare("INSERT INTO edition_metadata_prs(ob_issue_no,revision,repo,branch,path,content_yaml,pr_number,commit_sha) VALUES (1400,2,'ituob/data','rt-meta-1400-r2',?,?,?,?)").run(artifact.path,artifact.content,metadataPr.prNumber,metadataPr.commitSha);
    fake.mergePr(metadataPr.prNumber,"m".repeat(40));const id=await register();
    const result=await publishEdition(db,admin,1400,fake);
    expect(result.published).toEqual([id]);expect(state(id)).toBe("published");
    expect(fake.pinRequests[0].items).toEqual([{submissionId:id,mergeSha:"r".repeat(40)},{submissionId:`general-${message.id}-r1`,mergeSha:"g".repeat(40)},{submissionId:"edition-1400-metadata-r2",mergeSha:"m".repeat(40)}]);
    expect(await verifyChain(db)).toBeNull();
  });
  it("keeps an open general-only issue editable when newly authored metadata is not review-ready",async()=>{
    await general();await openEdition(db,admin,1400);
    await saveMetadata(db,admin,1400,{metadata:{id:1400},expected_revision:0});
    await expect(publishEdition(db,admin,1400,fake)).rejects.toThrow(/metadata must be scheduled/);
    expect(edition().status).toBe("open");expect(fake.pinRequests).toHaveLength(0);
    expect(sqlite.prepare("SELECT count(*) n FROM audit_log WHERE action='edition.composing'").get()?.n).toBe(0);
  });
  it("preserves register-only publication without inventing metadata or general content",async()=>{
    const id=await register();expect((await publishEdition(db,admin,1400,fake)).published).toEqual([id]);
    expect(fake.pinRequests[0].items).toEqual([{submissionId:id,mergeSha:"r".repeat(40)}]);
    expect((await readEdition(db,admin,1400)).general_messages).toEqual([]);expect(await verifyChain(db)).toBeNull();
  });
  it("does not drop an edition's general content when its final register item is removed",async()=>{
    await general();const id=await register();await removeItem(db,admin,1400,id);
    expect(edition().status).toBe("composing");expect(state(id)).toBe("merged");
    expect((await publishEdition(db,admin,1400,fake)).edition.status).toBe("published");
  });
  it("freezes general creation and editing before even the first upstream merge read",async()=>{
    const message=await general();await openEdition(db,admin,1400);
    const original=fake.getGeneralMessagePullRequest.bind(fake);
    vi.spyOn(fake,"getGeneralMessagePullRequest").mockImplementation(async request=>{
      expect(edition().status).toBe("composing");
      await expect(createGeneralMessage(db,editor,{ob_issue_no:1400,type:value.type,value})).rejects.toBeInstanceOf(ConflictError);
      await expect(saveGeneralMessage(db,editor,message.id,{expected_revision:1,value})).rejects.toBeInstanceOf(ConflictError);
      return original(request);
    });
    expect((await publishEdition(db,admin,1400,fake)).edition.status).toBe("published");
  });
  it("keeps general-only edition composing during pending staging and upstream failure, then resumes",async()=>{
    await general();await openEdition(db,admin,1400);
    const bump=vi.spyOn(fake,"bumpDataPin").mockResolvedValueOnce({freezeSha:"",siteCommit:"",pending:{prNumber:1,url:"https://example.test/pr/1",reason:"Waiting for staging"}}).mockRejectedValueOnce(new Error("upstream unavailable"));
    const pending=await publishEdition(db,admin,1400,fake);expect(pending.pending).toBeTruthy();expect(edition().status).toBe("composing");expect(edition().freeze_sha).toBeNull();
    await expect(publishEdition(db,admin,1400,fake)).rejects.toBeInstanceOf(UpstreamError);expect(edition().status).toBe("composing");expect(edition().published_at).toBeNull();
    bump.mockRestore();expect((await publishEdition(db,admin,1400,fake)).edition.status).toBe("published");
  });
  it("fails closed on merge verification outages and never bumps or publishes",async()=>{
    await general();await openEdition(db,admin,1400);fake.failGet=true;
    await expect(publishEdition(db,admin,1400,fake)).rejects.toBeInstanceOf(UpstreamError);
    expect(fake.pinRequests).toHaveLength(0);expect(edition().status).toBe("composing");expect(edition().published_at).toBeNull();
  });
  it.each(["revision","approved bytes","reservation bytes","added record"])("atomically rejects changed %s during upstream pin request",async change=>{
    const message=await general();const id=await register();
    vi.spyOn(fake,"bumpDataPin").mockImplementationOnce(async()=>{
      if(change==="revision")sqlite.prepare("UPDATE general_messages SET revision=2 WHERE id=?").run(message.id);
      if(change==="approved bytes")sqlite.prepare("UPDATE general_messages SET content_yaml='different' WHERE id=?").run(message.id);
      if(change==="reservation bytes")sqlite.prepare("UPDATE general_message_prs SET content_yaml='different' WHERE message_id=?").run(message.id);
      if(change==="added record")sqlite.prepare("INSERT INTO general_messages(id,ob_issue_no,type,class_name,path,value_json,revision,updated_at) VALUES ('OTHER',1400,'misc_communications','GeneralMiscCommunications','ob-issues/1400/misc_communications/002.yaml','{}',1,'now')").run();
      return {freezeSha:"stale",siteCommit:"stale"};
    });
    await expect(publishEdition(db,admin,1400,fake)).rejects.toBeInstanceOf(ConflictError);
    expect(edition().status).toBe("composing");expect(edition().freeze_sha).toBeNull();expect(state(id)).toBe("scheduled");
    expect(sqlite.prepare("SELECT count(*) n FROM audit_log WHERE action='edition.staged'").get()?.n).toBe(0);
    expect(await verifyChain(db)).toBeNull();
  });
  it("preserves the existing register-selection concurrency check when general messages are included",async()=>{
    await general();const first=await register();
    vi.spyOn(fake,"bumpDataPin").mockImplementationOnce(async()=>{
      await register("LATE");return {freezeSha:"stale",siteCommit:"stale"};
    });
    await expect(publishEdition(db,admin,1400,fake)).rejects.toBeInstanceOf(ConflictError);
    expect(state(first)).toBe("scheduled");expect(state("LATE")).toBe("scheduled");
    expect(edition().status).toBe("composing");expect(edition().freeze_sha).toBeNull();
    expect(await verifyChain(db)).toBeNull();
  });
  it("does not record a second staging transition when another publisher advances the edition during the request",async()=>{
    await general();await openEdition(db,admin,1400);
    vi.spyOn(fake,"bumpDataPin").mockImplementationOnce(async()=>{
      sqlite.prepare("UPDATE editions SET status='staged',freeze_sha='other-freeze',staging_commit='other-site' WHERE ob_issue_no=1400").run();
      return {freezeSha:"stale",siteCommit:"stale"};
    });
    await expect(publishEdition(db,admin,1400,fake)).rejects.toBeInstanceOf(ConflictError);
    expect(edition().status).toBe("staged");expect(edition().freeze_sha).toBe("other-freeze");expect(edition().published_at).toBeNull();
    expect(sqlite.prepare("SELECT count(*) n FROM audit_log WHERE action IN ('edition.staged','edition.published')").get()?.n).toBe(0);
  });
  it("rejects a forged reservation whose bytes differ from the approved artifact",async()=>{
    await general();sqlite.prepare("UPDATE general_message_prs SET content_yaml='forged'").run();
    const selection=await generalSelection(db,1400);
    expect(()=>requireGeneralReviews(1400,selection)).toThrow(/exact approved revision/);
  });
  it("requires admin and still refuses an empty edition",async()=>{
    await openEdition(db,admin,1400);
    await expect(publishEdition(db,editor,1400,fake)).rejects.toBeInstanceOf(Forbidden);
    await expect(publishEdition(db,admin,1400,fake)).rejects.toBeInstanceOf(ConflictError);expect(edition().status).toBe("open");
  });
  it("enables general-only composer publication without claiming unverified reviews merged",()=>{
    const open={ob_issue_no:1400,status:"open" as const,freeze_sha:null,meta_pr:null,staging_commit:null,published_at:null};
    expect(canPublishEdition(open,0,1)).toBe(true);expect(canPublishEdition(open,0,0)).toBe(false);
    expect(canPublishEdition({...open,status:"published"},0,1)).toBe(false);expect(canPublishEdition({...open,status:"composing"},1,0)).toBe(true);
    expect(generalMessageStatus("review_pr_created")).toContain("merge is verified when publishing");
  });
});
