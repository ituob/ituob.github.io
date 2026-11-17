-- Canonical general-message drafts. Approved YAML is frozen until staff create a
-- new revision; a reserved review permanently locks that record against edits.
CREATE TABLE general_messages (
  id TEXT PRIMARY KEY,
  ob_issue_no INTEGER NOT NULL CHECK (ob_issue_no BETWEEN 1 AND 99999),
  type TEXT NOT NULL,
  class_name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  revision INTEGER NOT NULL CHECK (revision > 0),
  approved_at TEXT,
  approved_by TEXT REFERENCES users(id),
  content_yaml TEXT,
  updated_at TEXT NOT NULL,
  CHECK ((approved_at IS NULL AND approved_by IS NULL AND content_yaml IS NULL)
    OR (approved_at IS NOT NULL AND approved_by IS NOT NULL AND content_yaml IS NOT NULL))
);
CREATE INDEX general_messages_issue ON general_messages(ob_issue_no,type);
CREATE TABLE general_message_prs (
  message_id TEXT NOT NULL REFERENCES general_messages(id),
  revision INTEGER NOT NULL,
  repo TEXT NOT NULL,
  branch TEXT NOT NULL,
  path TEXT NOT NULL,
  content_yaml TEXT NOT NULL,
  pr_number INTEGER,
  commit_sha TEXT,
  pr_url TEXT,
  PRIMARY KEY (message_id,revision)
);

-- Approval snapshots survive subsequent pre-PR editing; publication reads the
-- current approved revision and reservations retain exactly these same bytes.
CREATE TABLE general_message_approvals (
  message_id TEXT NOT NULL REFERENCES general_messages(id),
  revision INTEGER NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  content_yaml TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  approved_by TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY(message_id,revision)
);
