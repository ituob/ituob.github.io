// Demo content for `npm run dev:local` ONLY (applied to the local D1 by scripts/dev-local.mjs).
// Rows are inserted straight into the local database so every me/ and admin/ page has something
// to show on a walkthrough. Idempotent (INSERT OR IGNORE). Never run against a remote database.
const q = (s) => `'${String(s).replaceAll("'", "''")}'`;
const T = "2026-11-10T09:00:00.000Z";
const T2 = "2026-11-12T14:30:00.000Z";
const T3 = "2026-11-15T10:15:00.000Z";
const ALAND = "mock-member-aland", EDITOR = "mock-itu-editor", ADMIN = "mock-itu-admin";

const payload = (company, iin) => `type: ADD\ndata:\n  _class: E118Amendment\n  entries:\n    - country_or_area:\n        en: Aland (Mock Republic)\n      company_name: ${company}\n      issue_id_number: "${iin}"\n`;
const submissions = [
  { id: "01DEMO0SUBMISSION00DRAFT01", state: "draft", at: T, company: "Aland Mobile (draft)", iin: "89 358 01" },
  { id: "01DEMO0SUBMISSION00SUBMIT2", state: "submitted", at: T2, company: "Aland Telecom Oy", iin: "89 358 02" },
  { id: "01DEMO0SUBMISSION00REVIEW3", state: "in_review", at: T3, company: "Aland Cable Networks", iin: "89 358 03" },
];

export function demoSeedSql() {
  // Earlier seeds used 24/25-character ids, which the discussion client rejects (it needs 26); drop those rows so the corrected ones replace them.
  const out = [
    `DELETE FROM notifications WHERE id LIKE '01DEMO%' AND length(id) <> 26;`,
    `DELETE FROM comment_revisions WHERE comment_id LIKE '01DEMO%' AND length(comment_id) <> 26;`,
    `DELETE FROM comments WHERE id LIKE '01DEMO%' AND length(id) <> 26;`,
    ...["review_state", "submission_participants", "submission_revisions"].map(t => `DELETE FROM ${t} WHERE submission_id LIKE '01DEMO%' AND length(submission_id) <> 26;`),
    `DELETE FROM submissions WHERE id LIKE '01DEMO%' AND length(id) <> 26;`,
  ];
  for (const s of submissions) {
    const sha = s.id.toLowerCase().padEnd(64, "0");
    out.push(
      `INSERT OR IGNORE INTO submissions (id,proposer_id,affiliation_kind,affiliation_member_id,register_id,slug,action_type,state,current_rev,created_at,updated_at,version) VALUES (${q(s.id)},${q(ALAND)},'member','MOCK-A','E118_IIN','e118-iin','ADD',${q(s.state)},1,${q(s.at)},${q(s.at)},1);`,
      `INSERT OR IGNORE INTO submission_revisions (submission_id,rev,payload_yaml,payload_sha,validation,created_by,created_at) VALUES (${q(s.id)},1,${q(payload(s.company, s.iin))},${q(sha)},'{"stage1":[],"stage2":[]}',${q(ALAND)},${q(s.at)});`,
      `INSERT OR IGNORE INTO submission_participants (submission_id,user_id,role,added_by,added_at) VALUES (${q(s.id)},${q(ALAND)},'proposer',NULL,${q(s.at)});`,
    );
    if (s.state !== "draft") out.push(`INSERT INTO review_state (submission_id,rev,from_state,to_state,actor_id,actor_kind,reason,at) SELECT ${q(s.id)},1,'draft','submitted',${q(ALAND)},'user',NULL,${q(s.at)} WHERE NOT EXISTS (SELECT 1 FROM review_state WHERE submission_id=${q(s.id)});`);
  }
  const review = submissions[2];
  out.push(
    `INSERT OR IGNORE INTO submission_participants (submission_id,user_id,role,added_by,added_at) VALUES (${q(review.id)},${q(EDITOR)},'reviewer',${q(ADMIN)},${q(T3)});`,
    `INSERT INTO review_state (submission_id,rev,from_state,to_state,actor_id,actor_kind,reason,at) SELECT ${q(review.id)},1,'submitted','in_review',${q(EDITOR)},'user','Review started',${q(T3)} WHERE NOT EXISTS (SELECT 1 FROM review_state WHERE submission_id=${q(review.id)} AND to_state='in_review');`,
    `INSERT OR IGNORE INTO comments (id,submission_id,parent_id,root_id,author_id,affiliation_kind,affiliation_member_id,kind,current_rev,created_at) VALUES ('01DEMO0COMMENT000000000001',${q(review.id)},NULL,'01DEMO0COMMENT000000000001',${q(EDITOR)},'itu',NULL,'comment',1,${q(T3)});`,
    `INSERT OR IGNORE INTO comment_revisions (comment_id,rev,body,mentions,edited_by,created_at) VALUES ('01DEMO0COMMENT000000000001',1,'Could you confirm the issuer identification number with the national regulator?','[]',${q(EDITOR)},${q(T3)});`,
    `INSERT OR IGNORE INTO comments (id,submission_id,parent_id,root_id,author_id,affiliation_kind,affiliation_member_id,kind,current_rev,created_at) VALUES ('01DEMO0COMMENT000000000002',${q(review.id)},'01DEMO0COMMENT000000000001','01DEMO0COMMENT000000000001',${q(ALAND)},'member','MOCK-A','comment',1,${q(T3)});`,
    `INSERT OR IGNORE INTO comment_revisions (comment_id,rev,body,mentions,edited_by,created_at) VALUES ('01DEMO0COMMENT000000000002',1,'Confirmed with the regulator this morning; the number is correct.','[]',${q(ALAND)},${q(T3)});`,
  );
  const note = (id, user, sub, kind, payload, read) =>
    `INSERT OR IGNORE INTO notifications (id,user_id,submission_id,kind,ref_type,ref_id,dedupe_key,payload,read_at,created_at) VALUES (${q(id)},${q(user)},${q(sub)},${q(kind)},'submission',${q(sub)},${q("demo:" + id)},${q(JSON.stringify(payload))},${read ? q(T3) : "NULL"},${q(T3)});`;
  out.push(
    note("01DEMO0NOTIFY0000000000001", ALAND, review.id, "submission.in_review", { register_id: "E118_IIN", slug: "e118-iin", actor_name: "ITU Editor", reason: "Review started" }, false),
    note("01DEMO0NOTIFY0000000000002", ALAND, review.id, "comment.created", { register_id: "E118_IIN", slug: "e118-iin", actor_name: "ITU Editor", excerpt: "Could you confirm the issuer identification number with the national regulator?" }, false),
    note("01DEMO0NOTIFY0000000000003", EDITOR, submissions[1].id, "submission.submitted", { register_id: "E118_IIN", slug: "e118-iin", actor_name: "Aland Delegate", reason: "Submitted for review" }, false),
    note("01DEMO0NOTIFY0000000000004", ADMIN, submissions[1].id, "submission.submitted", { register_id: "E118_IIN", slug: "e118-iin", actor_name: "Aland Delegate", reason: "Submitted for review" }, true),
    `INSERT OR IGNORE INTO editions (ob_issue_no,status,created_at) SELECT 1351,'open',${q(T)} WHERE NOT EXISTS (SELECT 1 FROM editions WHERE status IN ('open','composing','staged'));`,
  );
  return out.join("\n") + "\n";
}
if (import.meta.url === `file://${process.argv[1]}`) process.stdout.write(demoSeedSql());
