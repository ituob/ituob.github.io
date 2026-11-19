import { beforeEach, expect, it } from "vitest";
import { approveGeneralMessage, generalMessageArtifact, importGeneralMessage, readGeneralMessage, saveGeneralMessage } from "../worker/lib/general-messages.ts";
import { unpackJSON, unpackText } from "../worker/lib/general-message-storage.ts";
import { FakeRepoReader } from "../worker/lib/repo-reader.ts";
import { ConflictError } from "../worker/lib/membership.ts";
import { verifyChain } from "../worker/lib/audit.ts";
import { parseYaml } from "../src/lib/form/yaml-io.ts";
import type { Session } from "../worker/lib/types.ts";
import { BOOTSTRAP_ADMIN_ID, db, seedFixtures } from "./helpers.ts";

const admin: Session = { userId: BOOTSTRAP_ADMIN_ID, roles: ["itu-admin"], memberStateId: null };
const path = "ob-issues/1400/telephone_service_2/001.yaml";
const source = "---\n# Original formatting\ntype: telephone_service_2\nob_issue_no: '1400'\ncontents: []\n";
const imported = (text = source, database = db()) => importGeneralMessage(database, admin,
  { ob_issue_no: 1400, path }, new FakeRepoReader({ [`o/r:${path}`]: text }), "o/r");

beforeEach(seedFixtures);

it("competing compressed edits commit one value without changing the imported source", async () => {
  const largeSource = `# ${"Source comment. ".repeat(8_000)}\n${source}`;
  const draft = await imported(largeSource);
  const values = ["First", "Second"].map(label => ({ ...draft.value, text: `${label} `.repeat(25_000) }));
  const outcomes = await Promise.allSettled(values.map(value => saveGeneralMessage(db(), admin, draft.id, { expected_revision: 1, value })));
  const winners = outcomes.flatMap((outcome, index) => outcome.status === "fulfilled" ? [index] : []);
  expect(winners).toHaveLength(1);
  for (const outcome of outcomes) if (outcome.status === "rejected") expect(outcome.reason).toBeInstanceOf(ConflictError);
  const winner = values[winners[0]];
  const current = await readGeneralMessage(db(), admin, draft.id);
  expect(current.revision).toBe(2);
  expect(current.value).toEqual(winner);
  const row = (await db().prepare("SELECT source_yaml,value_json FROM general_messages WHERE id=?1").bind(draft.id)
    .first<{ source_yaml: string; value_json: string }>())!;
  expect(row.source_yaml.startsWith("~ituob-gzip-v1:")).toBe(true);
  expect(JSON.parse(row.value_json)).toEqual(expect.stringMatching(/^~ituob-gzip-v1:/));
  expect(await unpackText(row.source_yaml)).toBe(largeSource);
  expect(await unpackJSON(row.value_json)).toEqual(winner);
  const approved = await approveGeneralMessage(db(), admin, draft.id, 2);
  expect(parseYaml(approved.content_yaml!)).toEqual(winner);
  expect(approved.content_yaml).not.toBe(largeSource);
  await expect(saveGeneralMessage(db(), admin, draft.id, { expected_revision: 1, value: draft.value })).rejects.toBeInstanceOf(ConflictError);
  expect((await generalMessageArtifact(db(), draft.id, 2)).content).toBe(approved.content_yaml);
  expect(await verifyChain(db())).toBeNull();
});

it("a stale approval cannot approve a newer save while it reads source_yaml", async () => {
  const draft = await imported();
  const value = { ...draft.value, text: "Concurrent writer" };
  const real = db();
  let intercepted = false;
  // Schedule a genuine second public write after approval reads revision 1,
  // before its source read completes; leave all SQL and transactions real.
  const racing = new Proxy(real, { get(target, key) {
    if (key === "prepare") return (sql: string) => {
      const statement = target.prepare(sql);
      if (!sql.startsWith("SELECT source_yaml FROM general_messages")) return statement;
      return { bind: (...args: unknown[]) => ({ first: async () => {
        intercepted = true;
        await saveGeneralMessage(real, admin, draft.id, { expected_revision: 1, value });
        return statement.bind(...args).first();
      } }) };
    };
    const member = Reflect.get(target, key);
    return typeof member === "function" ? member.bind(target) : member;
  } }) as D1Database;
  await expect(approveGeneralMessage(racing, admin, draft.id, 1)).rejects.toBeInstanceOf(ConflictError);
  expect(intercepted).toBe(true);
  const current = await readGeneralMessage(real, admin, draft.id);
  expect(current).toMatchObject({ revision: 2, value, approved_at: null, content_yaml: null });
  expect((await real.prepare("SELECT count(*) AS n FROM general_message_approvals WHERE message_id=?1").bind(draft.id).first<{ n: number }>())!.n).toBe(0);
  await approveGeneralMessage(real, admin, draft.id, 2);
  expect(parseYaml((await generalMessageArtifact(real, draft.id, 2)).content)).toEqual(value);
  expect(await verifyChain(real)).toBeNull();
});

it("concurrent approvals produce one immutable snapshot and keep original source bytes", async () => {
  const draft = await imported();
  const attempts = await Promise.allSettled([
    approveGeneralMessage(db(), admin, draft.id, 1),
    approveGeneralMessage(db(), admin, draft.id, 1),
  ]);
  expect(attempts.some(outcome => outcome.status === "fulfilled")).toBe(true);
  for (const outcome of attempts) if (outcome.status === "rejected") expect(outcome.reason).toBeInstanceOf(ConflictError);
  expect((await generalMessageArtifact(db(), draft.id, 1)).content).toBe(source);
  const snapshots = (await db().prepare("SELECT revision,value_json,content_yaml FROM general_message_approvals WHERE message_id=?1").bind(draft.id)
    .all<{ revision: number; value_json: string; content_yaml: string }>()).results;
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0].revision).toBe(1);
  expect(await unpackText(snapshots[0].content_yaml)).toBe(source);
  expect(await unpackJSON(snapshots[0].value_json)).toEqual(draft.value);
  const saved = await saveGeneralMessage(db(), admin, draft.id, { expected_revision: 1, value: { ...draft.value, text: "New revision" } });
  expect(saved).toMatchObject({ revision: 2, approved_at: null, content_yaml: null });
  await expect(generalMessageArtifact(db(), draft.id, 2)).rejects.toBeInstanceOf(ConflictError);
  const reverted = await saveGeneralMessage(db(), admin, draft.id, { expected_revision: 2, value: draft.value });
  await approveGeneralMessage(db(), admin, draft.id, reverted.revision);
  expect((await generalMessageArtifact(db(), draft.id, 3)).content).toBe(source);
  expect(await verifyChain(db())).toBeNull();
});

it("same-path imports cannot mix one writer's value with another writer's source", async () => {
  const sources = [source, source.replace("contents: []", "contents: []\ntext: Second import")];
  const attempts = await Promise.allSettled(sources.map(text => imported(text)));
  const winners = attempts.flatMap((outcome, index) => outcome.status === "fulfilled" ? [{ index, draft: outcome.value }] : []);
  expect(winners).toHaveLength(1);
  for (const outcome of attempts) if (outcome.status === "rejected") expect(outcome.reason).toBeInstanceOf(ConflictError);
  const { index, draft } = winners[0];
  expect(draft.value).toEqual(parseYaml(sources[index]));
  await approveGeneralMessage(db(), admin, draft.id, 1);
  expect((await generalMessageArtifact(db(), draft.id, 1)).content).toBe(sources[index]);
  expect((await db().prepare("SELECT count(*) AS n FROM general_messages WHERE path=?1").bind(path).first<{ n: number }>())!.n).toBe(1);
  expect(await verifyChain(db())).toBeNull();
});
