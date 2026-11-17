import { beforeEach, expect, it, vi } from "vitest";
import { approveGeneralMessage, createGeneralMessage, generalMessageArtifact, importGeneralMessage, readGeneralMessage, saveGeneralMessage } from "../worker/lib/general-messages.ts";
import { FakeRepoReader } from "../worker/lib/repo-reader.ts";
import { toFormState, toInstance } from "../src/lib/form/model.ts";
import { verifyChain } from "../worker/lib/audit.ts";
import { ConflictError } from "../worker/lib/membership.ts";
import type { Session } from "../worker/lib/types.ts";
import { BOOTSTRAP_ADMIN_ID, db, seedFixtures } from "./helpers.ts";
import { parse } from "yaml";
import { stringifyYaml } from "../src/lib/form/yaml-io.ts";
import { MAX_STORED_BYTES, unpackJSON, unpackText } from "../worker/lib/general-message-storage.ts";
import { FakePatchPublisher, setPublisher } from "../worker/lib/publisher.ts";
import { generalSelection, requireGeneralReviews } from "../worker/lib/general-message-composition.ts";
import { openEdition, publishEdition, readEdition } from "../worker/lib/composer.ts";
import { ADMIN, api } from "./helpers.ts";
const admin: Session = {userId:BOOTSTRAP_ADMIN_ID,roles:["itu-admin"],memberStateId:null};
const value={ob_issue_no:"1400",type:"misc_communications",contents:{en:{type:"doc",content:[{type:"paragraph",content:[{type:"text",text:"Preserved notice"}]}]}}};
beforeEach(seedFixtures);
it("D1 large storage keeps multi-megabyte imported values and exact published bytes within every row budget", async () => {
  const value = { type: "telephone_service_2", ob_issue_no: "1400", contents: [{ communications: [{ contents: "Telephone café notice. ".repeat(110_000) }] }] };
  const source = "---\n# Preserve this source exactly\n" + stringifyYaml(value);
  expect(new TextEncoder().encode(source).length).toBeGreaterThan(2_000_000);
  expect(new TextEncoder().encode(JSON.stringify(value)).length).toBeGreaterThan(2_000_000);
  const path = "ob-issues/1400/telephone_service_2/001.yaml";
  const draft = await importGeneralMessage(db(), admin, { ob_issue_no: 1400, path }, new FakeRepoReader({ [`o/r:${path}`]: source }), "o/r");
  const saved = await saveGeneralMessage(db(), admin, draft.id, { expected_revision: 1, value: draft.value });
  await approveGeneralMessage(db(), admin, saved.id, saved.revision);
  expect((await generalMessageArtifact(db(), saved.id)).content).toBe(source);
  const raw = (await db().prepare("SELECT value_json,source_yaml,content_yaml FROM general_messages WHERE id=?1").bind(saved.id)
    .first<{ value_json: string; source_yaml: string; content_yaml: string }>())!;
  for (const text of Object.values(raw)) expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(MAX_STORED_BYTES);
  expect(await unpackJSON(raw.value_json)).toEqual(value);
  expect(await unpackText(raw.source_yaml)).toBe(source);
  expect(await unpackText(raw.content_yaml)).toBe(source);
  const snapshot = (await db().prepare("SELECT value_json,content_yaml FROM general_message_approvals WHERE message_id=?1").bind(saved.id)
    .first<{ value_json: string; content_yaml: string }>())!;
  expect(snapshot.value_json).toBe(raw.value_json);
  expect(snapshot.content_yaml).toBe(raw.content_yaml);
  const fake = new FakePatchPublisher();
  setPublisher(fake);
  try {
    const review = await api("POST", `/api/admin/general-messages/${saved.id}/review`, { access: ADMIN, body: { expected_revision: 2 } });
    expect(review.status).toBe(202);
    expect(review.json.pr.content_yaml).toBe(source);
    expect(fake.requests[0].content).toBe(source);
    expect((await api("GET", `/api/admin/general-messages/${saved.id}/review`, { access: ADMIN })).json.pr.content_yaml).toBe(source);
    const selection = await generalSelection(db(), 1400);
    expect(selection[0].content_yaml).toBe(raw.content_yaml);
    expect(selection[0].review_content_yaml).toBe(raw.content_yaml);
    expect(() => requireGeneralReviews(1400, selection)).not.toThrow();
    fake.mergePr(review.json.pr.pr_number, "g".repeat(40));
    await openEdition(db(), admin, 1400);
    const stalePin = vi.spyOn(fake, "bumpDataPin").mockImplementationOnce(async () => {
      await db().prepare("UPDATE general_messages SET content_yaml='changed during pinning' WHERE id=?1").bind(saved.id).run();
      return { freezeSha: "stale", siteCommit: "stale" };
    });
    try {
      await expect(publishEdition(db(), admin, 1400, fake)).rejects.toBeInstanceOf(ConflictError);
      expect(await db().prepare("SELECT status,freeze_sha FROM editions WHERE ob_issue_no=1400").first()).toEqual({ status: "composing", freeze_sha: null });
    } finally { stalePin.mockRestore(); }
    await db().prepare("UPDATE general_messages SET content_yaml=?2 WHERE id=?1").bind(saved.id, raw.content_yaml).run();
    expect((await publishEdition(db(), admin, 1400, fake)).edition.status).toBe("published");
    expect((await readEdition(db(), admin, 1400)).general_messages[0].content_yaml).toBe(source);
    expect(await verifyChain(db())).toBeNull();
  } finally { setPublisher(null); }
}, 60_000);
it.each(["sanc", "telephone_service_2"])("D1 retains imported %s source through form save and approval", async type => {
  const source = `---\n# Source formatting must survive\ntype: ${type}\nob_issue_no: '1400'\ncontents: ${type === "sanc" ? "'Original notice'" : "[]"}\n`;
  const path = `ob-issues/1400/${type}/001.yaml`;
  const reader = new FakeRepoReader({ [`o/r:${path}`]: source });
  const imported = await importGeneralMessage(db(), admin, { ob_issue_no: 1400, path }, reader, "o/r");
  const saved = await saveGeneralMessage(db(), admin, imported.id, { expected_revision: 1, value: toInstance(toFormState(imported.class_name, imported.value).state) });
  const approved = await approveGeneralMessage(db(), admin, saved.id, saved.revision);
  expect(approved.content_yaml).toBe(source);
  expect((await generalMessageArtifact(db(), saved.id)).content).toBe(source);
  expect(await verifyChain(db())).toBeNull();
});
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

it.each([
  {type:"sanc",contents:{en:{type:"doc",content:[]}},items:[{country:"Example",sanc:"7-001"}],notes:"Preserved note"},
  {type:"telephone_service_2",contents:[{country_name:{en:"Example"},communications:[{contents:"Readable authored telephone prose"}]}]},
])("D1 freezes typed $type authoring without rewriting its prose",async message => {
  const authored = {...message,ob_issue_no:"1400"};
  const saved = await createGeneralMessage(db(),admin,{ob_issue_no:1400,type:message.type,value:authored});
  await approveGeneralMessage(db(),admin,saved.id,1);
  const artifact = await generalMessageArtifact(db(),saved.id,1);
  expect(artifact.path).toBe(`ob-issues/1400/${message.type}/001.yaml`);
  expect(parse(artifact.content)).toEqual(authored);
  expect((await readGeneralMessage(db(),admin,saved.id)).value).toEqual(authored);
});
