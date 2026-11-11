-- #103 card 103-06: the admin composer and the revert path. DDL follows
-- docs/submission-workflow.adoc "D1 schema"; DEVIATIONS are marked.
CREATE TABLE editions (
  ob_issue_no    INTEGER PRIMARY KEY,
  status         TEXT NOT NULL CHECK (status IN ('open','composing','staged','published')),
  freeze_sha     TEXT,
  meta_pr        INTEGER,
  staging_commit TEXT,
  published_at   TEXT,
  created_at     TEXT NOT NULL
);
-- DEVIATION: both are indexes, not prose. "At most one open edition" (the approval default)
-- and "at most one in composing/staged" (a pin bump is all or nothing, so two editions
-- can never be staged together) are enforced by the database.
CREATE UNIQUE INDEX idx_edition_one_open ON editions((1)) WHERE status = 'open';
CREATE UNIQUE INDEX idx_edition_one_active ON editions((1)) WHERE status IN ('composing','staged');

CREATE TABLE edition_items (
  ob_issue_no   INTEGER NOT NULL REFERENCES editions(ob_issue_no),
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  position      INTEGER NOT NULL,
  PRIMARY KEY (ob_issue_no, submission_id)
);
-- A submission sits in at most one edition.
CREATE UNIQUE INDEX idx_edition_item_sub ON edition_items(submission_id);

-- DEVIATION: the design note puts the revert in the same PR machinery (queue kind=revert) but
-- gives it no table. A revert PR is not the submission's patch PR, so it has its own row.
-- `attempt` lets a revert PR that was closed unmerged be replaced by a new one (new branch).
CREATE TABLE submission_reverts (
  submission_id   TEXT NOT NULL REFERENCES submissions(id),
  attempt         INTEGER NOT NULL,
  repo            TEXT NOT NULL,
  branch          TEXT NOT NULL,
  path            TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  reason          TEXT NOT NULL,
  requested_by    TEXT REFERENCES users(id),
  pr_number       INTEGER,
  pr_state        TEXT CHECK (pr_state IN ('open','closed','merged')),
  merge_sha       TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (submission_id, attempt),
  CHECK (branch LIKE 'rt-sub-%')
);
CREATE UNIQUE INDEX idx_revert_branch ON submission_reverts(repo, branch);
