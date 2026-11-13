import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { verifyChain } from "../worker/lib/audit.ts";
import { FakePatchPublisher, setPublisher } from "../worker/lib/publisher.ts";
import { ADMIN, api, db, seedFixtures } from "./helpers.ts";
let fake:FakePatchPublisher;
const value={type:"misc_communications",ob_issue_no:"1400",contents:"Issue notice"};
const call=(method:string,path:string,body?:unknown)=>api(method,path,{access:ADMIN,body});
const composer="/api/admin/composer/editions/1400";
beforeEach(async()=>{await seedFixtures();fake=new FakePatchPublisher();setPublisher(fake);});
afterEach(()=>setPublisher(null));
async function reviewed(merged=true) {
  const created=await call("POST","/api/admin/general-messages",{ob_issue_no:1400,type:value.type,value});
  expect(created.status).toBe(200);const message=created.json.draft;
  expect((await call("POST",`/api/admin/general-messages/${message.id}/approve`,{expected_revision:1})).status).toBe(200);
  const review=await call("POST",`/api/admin/general-messages/${message.id}/review`,{expected_revision:1});
  expect(review.status).toBe(202);if(merged)fake.mergePr(review.json.pr.pr_number,"g".repeat(40));
  expect((await call("POST","/api/admin/composer/editions",{ob_issue_no:1400})).status).toBe(201);
  return message;
}
it("API/D1 publishes general-only editions with the verified merge SHA in frozen ancestry",async()=>{
  const message=await reviewed();const before=await call("GET",composer);
  expect(before.json.items).toEqual([]);expect(before.json.general_messages).toMatchObject([{id:message.id,status:"review_pr_created"}]);
  const published=await call("POST",`${composer}/publish`,{});
  expect(published.status).toBe(200);expect(published.json.edition.status).toBe("published");expect(published.json.published).toEqual([]);
  expect(fake.pinRequests[0].items).toEqual([{submissionId:`general-${message.id}-r1`,mergeSha:"g".repeat(40)}]);
  expect((await call("GET",composer)).json.general_messages[0].status).toBe("published");
  expect(await db().prepare("SELECT count(*) n FROM edition_metadata").first()).toEqual({n:0});
  expect(await verifyChain(db())).toBeNull();
});
it("API/D1 refuses unmerged general reviews without a pin or publication record",async()=>{
  await reviewed(false);const response=await call("POST",`${composer}/publish`,{});
  expect(response.status).toBe(409);expect(response.json.error).toContain("must be merged");expect(fake.pinRequests).toHaveLength(0);
  expect(await db().prepare("SELECT status,published_at FROM editions WHERE ob_issue_no=1400").first()).toEqual({status:"composing",published_at:null});
  expect(await verifyChain(db())).toBeNull();
});
it("API/D1 freezes general-only authoring before upstream requests and keeps pending issues composing",async()=>{
  const message=await reviewed();const bump=vi.spyOn(fake,"bumpDataPin").mockImplementationOnce(async()=>{
    expect((await call("POST","/api/admin/general-messages",{ob_issue_no:1400,type:value.type,value})).status).toBe(409);
    expect((await call("POST",`/api/admin/general-messages/${message.id}`,{expected_revision:1,value})).status).toBe(409);
    return {freezeSha:"",siteCommit:"",pending:{prNumber:88,url:"https://example.test/pr/88",reason:"Awaiting deployment"}};
  });
  const response=await call("POST",`${composer}/publish`,{});expect(response.status).toBe(202);expect(response.json.edition.status).toBe("composing");
  expect(await db().prepare("SELECT freeze_sha,published_at FROM editions WHERE ob_issue_no=1400").first()).toEqual({freeze_sha:null,published_at:null});
  bump.mockRestore();expect((await call("POST",`${composer}/publish`,{})).json.edition.status).toBe("published");
  expect(await verifyChain(db())).toBeNull();
});
it("API/D1 exact-selection guard rolls staging back if an approved message changes during pinning",async()=>{
  const message=await reviewed();vi.spyOn(fake,"bumpDataPin").mockImplementationOnce(async()=>{
    await db().prepare("UPDATE general_messages SET content_yaml='different' WHERE id=?1").bind(message.id).run();
    return {freezeSha:"stale",siteCommit:"stale"};
  });
  const response=await call("POST",`${composer}/publish`,{});expect(response.status).toBe(409);
  expect(await db().prepare("SELECT status,freeze_sha,published_at FROM editions WHERE ob_issue_no=1400").first()).toEqual({status:"composing",freeze_sha:null,published_at:null});
  expect(await db().prepare("SELECT count(*) n FROM audit_log WHERE action='edition.staged'").first()).toEqual({n:0});
  expect(await verifyChain(db())).toBeNull();
});
