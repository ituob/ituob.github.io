-- #104 discussion and notifications. DDL follows docs/discussion-notifications.adoc
-- (design-workflow @4e864ce). DEVIATIONS are marked.
CREATE TABLE user_handles (
  user_id    TEXT PRIMARY KEY REFERENCES users(id),
  handle     TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL
);
CREATE TABLE handle_history (
  handle     TEXT PRIMARY KEY COLLATE NOCASE,
  user_id    TEXT NOT NULL REFERENCES users(id),
  retired_at TEXT NOT NULL
);

-- One row per comment identity; content lives in comment_revisions.
-- DEVIATION: author_id is nullable for kind='system' rows only (CHECK below).
CREATE TABLE comments (
  id                    TEXT PRIMARY KEY,
  submission_id         TEXT NOT NULL REFERENCES submissions(id),
  parent_id             TEXT REFERENCES comments(id),
  root_id               TEXT NOT NULL,
  author_id             TEXT REFERENCES users(id),
  affiliation_kind      TEXT CHECK (affiliation_kind IN ('itu','member')),
  affiliation_member_id TEXT,
  kind                  TEXT NOT NULL DEFAULT 'comment' CHECK (kind IN ('comment','system')),
  anchor_rev            INTEGER,
  anchor_path           TEXT,
  anchor_line           INTEGER,
  anchor_quote          TEXT,
  current_rev           INTEGER NOT NULL DEFAULT 1,
  deleted_at            TEXT,
  deleted_by            TEXT REFERENCES users(id),
  delete_reason         TEXT,
  created_at            TEXT NOT NULL,
  CHECK (kind = 'system' OR (author_id IS NOT NULL AND affiliation_kind IS NOT NULL))
);
CREATE INDEX idx_c_sub ON comments(submission_id, created_at);
CREATE INDEX idx_c_root ON comments(root_id, created_at);

-- Immutable: the application issues INSERT only (tested).
CREATE TABLE comment_revisions (
  comment_id TEXT NOT NULL REFERENCES comments(id),
  rev        INTEGER NOT NULL,
  body       TEXT NOT NULL,
  mentions   TEXT NOT NULL,
  edited_by  TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (comment_id, rev)
);

CREATE TABLE discussion_state_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  closed        INTEGER NOT NULL,
  actor_id      TEXT NOT NULL REFERENCES users(id),
  reason        TEXT NOT NULL,
  at            TEXT NOT NULL
);

CREATE TABLE submission_participants (
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  user_id       TEXT NOT NULL REFERENCES users(id),
  role          TEXT NOT NULL CHECK (role IN ('proposer','reviewer','mentioned','contact','watcher')),
  added_by      TEXT,
  added_at      TEXT NOT NULL,
  PRIMARY KEY (submission_id, user_id, role)
);

-- In-app inbox AND the durable notification record: one row per (event, recipient).
-- DEVIATION: enqueued_at (outbox marker: NULL = not yet handed to the queue).
CREATE TABLE notifications (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id),
  submission_id     TEXT REFERENCES submissions(id),
  kind              TEXT NOT NULL,
  ref_type          TEXT,
  ref_id            TEXT,
  dedupe_key        TEXT NOT NULL,
  payload           TEXT NOT NULL,
  read_at           TEXT,
  created_at        TEXT NOT NULL,
  email_status      TEXT NOT NULL DEFAULT 'none'
    CHECK (email_status IN ('none','queued','sent','delivered','bounced','complained','failed','skipped')),
  email_reason      TEXT,
  email_attempts    INTEGER NOT NULL DEFAULT 0,
  email_provider_id TEXT,
  email_sent_at     TEXT,
  enqueued_at       TEXT
);
CREATE UNIQUE INDEX idx_n_dedupe ON notifications(dedupe_key);
CREATE INDEX idx_n_inbox ON notifications(user_id, read_at, created_at);
CREATE INDEX idx_n_sub ON notifications(submission_id, created_at);
CREATE INDEX idx_n_outbox ON notifications(email_status, enqueued_at);

CREATE TABLE notification_prefs (
  user_id    TEXT PRIMARY KEY REFERENCES users(id),
  level      TEXT NOT NULL DEFAULT 'all' CHECK (level IN ('all','mentions','none')),
  updated_at TEXT NOT NULL
);

CREATE TABLE email_suppressions (
  email      TEXT PRIMARY KEY COLLATE NOCASE,
  reason     TEXT NOT NULL CHECK (reason IN ('hard_bounce','complaint','manual')),
  first_seen TEXT NOT NULL,
  detail     TEXT
);

CREATE TABLE notification_counters (
  day    TEXT NOT NULL,
  metric TEXT NOT NULL,
  n      INTEGER NOT NULL,
  PRIMARY KEY (day, metric)
);
