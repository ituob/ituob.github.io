import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { demoSeedSql } from "../scripts/demo-seed.mjs";

// The seed is re-applied to a local database that may hold rows from earlier seeds. Earlier seeds used 24/25-character
// ids; the corrected seed deletes those, and must also delete everything that references them (foreign keys are ON in D1).
function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync("migrations").filter(n => n.endsWith(".sql")).sort()) db.exec(readFileSync(`migrations/${f}`, "utf8"));
  db.exec("PRAGMA foreign_keys=ON;");
  db.exec(`INSERT INTO users (id,email,display_name,created_at) VALUES ('mock-member-aland','a@mock.test','Aland','t'),('mock-itu-editor','e@mock.test','Editor','t'),('mock-itu-admin','ad@mock.test','Admin','t');
    INSERT INTO members (id,name,register_key,status,created_at,updated_at) VALUES ('MOCK-A','Aland','aland','active','t','t');`);
  return db;
}

/** The seed as the previous version wrote it: same rows, one padding zero removed from each demo id (so 24/25 characters). */
const oldSeedSql = () => demoSeedSql().split("\n").filter(l => !l.startsWith("DELETE FROM")).join("\n").replace(/01DEMO0[A-Z]+0[0-9A-Z]*/g, id => id.replace(/(01DEMO0[A-Z]+)0/, "$1"));

const OLD_REVIEW = "01DEMO0SUBMISSION0REVIEW3";
const count = (db: DatabaseSync, sql: string) => (db.prepare(sql).get() as { n: number }).n;

test("demo seed replaces old short-id demo rows that other tables reference", () => {
  const db = freshDb();
  db.exec(oldSeedSql());
  assert.equal(count(db, `SELECT count(*) n FROM submissions WHERE length(id) <> 26`), 3, "fixture: old short ids exist");
  db.exec(`
    INSERT INTO discussion_state_log (submission_id,closed,actor_id,reason,at) VALUES ('${OLD_REVIEW}',1,'mock-itu-editor','x','t');
    INSERT INTO submission_prs (submission_id,rev,repo,branch,path,content_yaml,content_sha,idempotency_key) VALUES ('${OLD_REVIEW}',1,'r','rt-sub-0','p','y','s','k0');
    INSERT INTO submission_reverts (submission_id,attempt,repo,branch,path,idempotency_key,reason,created_at) VALUES ('${OLD_REVIEW}',1,'r','rt-sub-1','p','k1','why','t');
    INSERT INTO edition_items (ob_issue_no,submission_id,position) VALUES (1351,'${OLD_REVIEW}',1);
    INSERT INTO webhook_deliveries (delivery_id,body_sha,event,submission_id,received_at) VALUES ('d','b','pull_request','${OLD_REVIEW}','t');
    INSERT INTO notifications (id,user_id,submission_id,kind,dedupe_key,payload,created_at) VALUES ('01JREALULID0000000000000AA','mock-member-aland','${OLD_REVIEW}','comment.created','k1','{}','t');
    INSERT INTO comments (id,submission_id,parent_id,root_id,author_id,affiliation_kind,kind,current_rev,created_at) VALUES ('01JREALULID0000000000000BB','${OLD_REVIEW}','01DEMO0COMMENT00000000001','01DEMO0COMMENT00000000001','mock-itu-editor','itu','comment',1,'t');
    INSERT INTO comment_revisions (comment_id,rev,body,mentions,edited_by,created_at) VALUES ('01JREALULID0000000000000BB',1,'reply','[]','mock-itu-editor','t');
  `);
  db.exec(demoSeedSql());
  assert.equal(count(db, `SELECT count(*) n FROM submissions WHERE length(id) <> 26`), 0);
  assert.equal(count(db, `SELECT count(*) n FROM submissions WHERE id LIKE '01DEMO%'`), 3);
  for (const t of ["discussion_state_log", "submission_prs", "submission_reverts", "edition_items", "webhook_deliveries", "notifications", "comments"])
    assert.equal(count(db, `SELECT count(*) n FROM ${t} WHERE submission_id = '${OLD_REVIEW}'`), 0, t);
  assert.equal(count(db, `SELECT count(*) n FROM comments WHERE id LIKE '01JREAL%'`), 0);
  assert.equal(count(db, `SELECT count(*) n FROM comments WHERE id LIKE '01DEMO%'`), 2);
  assert.deepEqual(db.prepare(`PRAGMA foreign_key_check`).all(), []);
  db.exec(demoSeedSql()); // idempotent
});

test("demo seed leaves rows of real (non-demo) submissions alone", () => {
  const db = freshDb();
  db.exec(oldSeedSql());
  db.exec(`INSERT INTO submissions (id,proposer_id,affiliation_kind,affiliation_member_id,register_id,slug,action_type,state,current_rev,created_at,updated_at,version) VALUES ('01JREALSUBMISSION00000000A','mock-member-aland','member','MOCK-A','E118_IIN','e118-iin','ADD','draft',1,'t','t',1);
    INSERT INTO discussion_state_log (submission_id,closed,actor_id,reason,at) VALUES ('01JREALSUBMISSION00000000A',1,'mock-itu-editor','x','t');`);
  db.exec(demoSeedSql());
  assert.equal(count(db, `SELECT count(*) n FROM discussion_state_log WHERE submission_id='01JREALSUBMISSION00000000A'`), 1);
});
