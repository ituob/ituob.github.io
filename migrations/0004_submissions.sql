-- #103 submission workflow core. DDL follows docs/submission-workflow.adoc
-- (design-workflow @4e864ce). Deviations are marked "DEVIATION".
-- Out of this card: editions / edition_items / review_assignments (composer).
CREATE TABLE submissions (
  id                    TEXT PRIMARY KEY,
  proposer_id           TEXT NOT NULL REFERENCES users(id),
  affiliation_kind      TEXT NOT NULL CHECK (affiliation_kind IN ('itu','member')),
  affiliation_member_id TEXT REFERENCES members(id),
  register_id           TEXT NOT NULL,
  slug                  TEXT NOT NULL,
  action_type           TEXT NOT NULL CHECK (action_type IN ('ADD','SUP','REP','LIR','MOD','DEL')),
  state                 TEXT NOT NULL CHECK (state IN ('draft','submitted','in_review','changes_requested',
                          'approved','rejected','withdrawn','pr_pending','pr_open','ci_failed','merged',
                          'scheduled','published')),
  current_rev           INTEGER NOT NULL DEFAULT 1,
  duplicate_of          TEXT,
  corrects_id           TEXT REFERENCES submissions(id),
  target_edition        INTEGER,
  seq                   INTEGER,
  discussion_closed     INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  version               INTEGER NOT NULL DEFAULT 0,
  CHECK ((affiliation_kind = 'itu' AND affiliation_member_id IS NULL)
      OR (affiliation_kind = 'member' AND affiliation_member_id IS NOT NULL))
);
CREATE INDEX idx_sub_state ON submissions(state, updated_at);
CREATE INDEX idx_sub_proposer ON submissions(proposer_id);
CREATE INDEX idx_sub_register ON submissions(register_id, state);

-- Immutable: the application issues INSERT only (tested).
CREATE TABLE submission_revisions (
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  rev           INTEGER NOT NULL,
  payload_yaml  TEXT NOT NULL,
  payload_sha   TEXT NOT NULL,
  validation    TEXT NOT NULL,
  created_by    TEXT NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL,
  PRIMARY KEY (submission_id, rev)
);

-- The issue's `review_state`: append-only typed transition history.
CREATE TABLE review_state (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  rev           INTEGER NOT NULL,
  from_state    TEXT,
  to_state      TEXT NOT NULL,
  actor_id      TEXT REFERENCES users(id),
  actor_kind    TEXT NOT NULL CHECK (actor_kind IN ('user','system','github')),
  reason        TEXT,
  at            TEXT NOT NULL,
  CHECK ((actor_kind = 'user') = (actor_id IS NOT NULL))
);
CREATE INDEX idx_rs_sub ON review_state(submission_id, id);

CREATE TABLE edition_seq (
  ob_issue_no INTEGER NOT NULL,
  slug        TEXT NOT NULL,
  next_seq    INTEGER NOT NULL,
  PRIMARY KEY (ob_issue_no, slug)
);

-- DEVIATION: adds content_yaml/content_sha, the final file bytes (derived
-- fields filled at approval); revision payload_yaml stays the member-authored body.
CREATE TABLE submission_prs (
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  rev           INTEGER NOT NULL,
  repo          TEXT NOT NULL,
  branch        TEXT NOT NULL,
  path          TEXT NOT NULL,
  content_yaml  TEXT NOT NULL,
  content_sha   TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  base_sha      TEXT,
  commit_sha    TEXT,
  pr_number     INTEGER,
  pr_state      TEXT CHECK (pr_state IN ('open','closed','merged')),
  merge_sha     TEXT,
  checks        TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  PRIMARY KEY (submission_id, rev),
  CHECK (branch LIKE 'rt-sub-%')
);
CREATE UNIQUE INDEX idx_pr_branch ON submission_prs(repo, branch);

-- Append-only, hash-chained. UNIQUE(prev_hash) makes a forked chain (two
-- concurrent appenders) fail the whole batch instead of silently forking.
-- DEVIATION: no Durable Object serialiser yet (design D6); this is the guard.
CREATE TABLE audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            TEXT NOT NULL,
  actor_id      TEXT REFERENCES users(id),
  actor_kind    TEXT NOT NULL CHECK (actor_kind IN ('user','system','github')),
  action        TEXT NOT NULL,
  subject_type  TEXT NOT NULL,
  subject_id    TEXT NOT NULL,
  submission_id TEXT,
  detail        TEXT,
  request_id    TEXT,
  prev_hash     TEXT NOT NULL,
  hash          TEXT NOT NULL
);
CREATE INDEX idx_audit_sub ON audit_log(submission_id, id);
CREATE UNIQUE INDEX idx_audit_prev ON audit_log(prev_hash);
