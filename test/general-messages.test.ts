import { beforeEach, expect, it } from "vitest";
import { approveGeneralMessage, createGeneralMessage, generalMessageArtifact, readGeneralMessage, saveGeneralMessage } from "../worker/lib/general-messages.ts";
import { verifyChain } from "../worker/lib/audit.ts";
import { ConflictError } from "../worker/lib/membership.ts";
import type { Session } from "../worker/lib/types.ts";
import { BOOTSTRAP_ADMIN_ID, db, seedFixtures } from "./helpers.ts";
import { parse } from "yaml";
const admin: Session = {userId:BOOTSTRAP_ADMIN_ID,roles:["itu-admin"],memberStateId:null};
const value={ob_issue_no:"1400",type:"misc_communications",contents:{en:{type:"doc",content:[{type:"paragraph",content:[{type:"text",text:"Preserved notice"}]}]}}};
beforeEach(seedFixtures);
it("D1 preserves exact approved general-message bytes and optimistic revisions",async () => {
  const first=await createGeneralMessage(db(),admin,{ob_issue_no:1400,type:value.type,value});
  const writes=await Promise.allSettled([
    saveGeneralMessage(db(),admin,first.id,{expected_revision:1,value:{...value,text:"First"}}),
    saveGeneralMessage(db(),admin,first.id,{expected_revision:1,value:{...value,text:"Second"}}),
  ]);
  expect(writes.filter(r=>r.status==="fulfilled")).toHaveLength(1);
  expect(writes.filter(r=>r.status==="rejected")).toHaveLength(1);
  const saved=await readGeneralMessage(db(),admin,first.id); expect(saved.revision).toBe(2);
  const approved=await approveGeneralMessage(db(),admin,first.id,2);
  const artifact=await generalMessageArtifact(db(),first.id,2);
  expect(artifact.content).toBe(approved.content_yaml); expect(parse(artifact.content)).toEqual(saved.value);
  expect(artifact.path).toBe("ob-issues/1400/misc_communications/001.yaml");
  await db().prepare("INSERT INTO general_message_prs(message_id,revision,repo,branch,path,content_yaml) VALUES (?1,2,'ituob/data','rt-msg',?2,?3)").bind(first.id,artifact.path,artifact.content).run();
  await expect(saveGeneralMessage(db(),admin,first.id,{expected_revision:2,value})).rejects.toBeInstanceOf(ConflictError);
  expect(await generalMessageArtifact(db(),first.id,2)).toEqual(artifact);
  expect(await verifyChain(db())).toBeNull();
});
it("D1 concurrent creates allocate distinct canonical message sequences",async () => {
  const attempts=await Promise.allSettled(Array.from({length:2},()=>createGeneralMessage(db(),admin,{ob_issue_no:1400,type:value.type,value})));
  // The append-only audit chain may reject a conflicting writer. A retry must
  // allocate the next sequence, never replace the successful writer's record.
  let saved=attempts.filter(r=>r.status==="fulfilled").map(r=>r.value);
  for(const attempt of attempts) if(attempt.status==="rejected") saved.push(await createGeneralMessage(db(),admin,{ob_issue_no:1400,type:value.type,value}));
  expect(saved.map(x=>x.path).sort()).toEqual(["ob-issues/1400/misc_communications/001.yaml","ob-issues/1400/misc_communications/002.yaml"]);
  expect(await verifyChain(db())).toBeNull();
});
