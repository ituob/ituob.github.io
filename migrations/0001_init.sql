-- Initial schema for the ituob.org Worker (D1): accounts and roles (#102, #105),
-- submissions and the composer (#103), discussion and notifications (#104).
-- Later schema changes go in new numbered files after this one.

-- #102 users (identity 'sub' as key).
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT,
  display_name  TEXT,
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);
CREATE INDEX users_email ON users (lower(email));

-- #105 DDL, as in docs/membership-roles.adoc.
CREATE TABLE members (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  register_key     TEXT NOT NULL UNIQUE,
  iso3166_alpha2   TEXT,
  itu_identifier   TEXT,
  status           TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','suspended','withdrawn')),
  member_since     TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE memberships (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind            TEXT NOT NULL CHECK (kind IN ('itu','member')),
  member_id       TEXT REFERENCES members(id) ON DELETE RESTRICT,
  status          TEXT NOT NULL
                  CHECK (status IN ('pending','active','rejected','deactivated')),
  claimed_at      TEXT,
  claim_note      TEXT,
  decided_by      TEXT REFERENCES users(id),
  decided_at      TEXT,
  decision_note   TEXT,
  created_at      TEXT NOT NULL,
  CHECK ( (kind = 'itu'    AND member_id IS NULL)
       OR (kind = 'member' AND member_id IS NOT NULL) )
);
CREATE UNIQUE INDEX memberships_one_live
  ON memberships (user_id) WHERE status IN ('pending','active');
CREATE INDEX memberships_member ON memberships (member_id, status);

CREATE TABLE user_roles (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role       TEXT NOT NULL CHECK (role IN ('itu-admin','itu-editor','member-submitter')),
  granted_by TEXT REFERENCES users(id),
  granted_at TEXT NOT NULL,
  PRIMARY KEY (user_id, role)
);

CREATE TABLE membership_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            TEXT NOT NULL,
  actor_id      TEXT REFERENCES users(id),
  subject_id    TEXT REFERENCES users(id),
  membership_id INTEGER REFERENCES memberships(id),
  event         TEXT NOT NULL,
  detail        TEXT
);

-- #102 sessions and OIDC flow state, as in docs/identity-accounts.adoc.
CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,        -- random row id (not the cookie)
  user_id         TEXT NOT NULL REFERENCES users(id),
  token_hash      TEXT NOT NULL UNIQUE,    -- SHA-256 of the cookie value
  prev_token_hash TEXT,                    -- rotation grace (60 s)
  rotated_at      TEXT NOT NULL,           -- last rotation (= created_at until the first)
  created_at      TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  expires_at      TEXT NOT NULL            -- absolute
);
CREATE INDEX sessions_user ON sessions (user_id);
CREATE INDEX sessions_prev ON sessions (prev_token_hash);

CREATE TABLE oidc_flows (
  id            TEXT PRIMARY KEY,
  state         TEXT NOT NULL,
  nonce         TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  return_to     TEXT NOT NULL,
  created_at    TEXT NOT NULL              -- TTL 10 min, swept lazily
);

-- Rotation on role/membership change is derived at read time from
-- membership_events / members.updated_at (see worker/lib/session.ts). Triggers
-- that touch sessions were tried and rejected: D1's meta.changes counts
-- trigger-written rows, which breaks membership.ts's `changes !== 1` guards.

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
  -- Set by an admin withdrawal just before it closes the PR, so the "closed"
  -- webhook our own close produces is not mistaken for a human closing the PR.
  closing_at    TEXT,
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
  edited_by  TEXT REFERENCES users(id),  -- DEVIATION: nullable, system comments have no author
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

-- #103 card 103-03: GitHub webhook back-channel. DEVIATIONS are marked.
-- Processed deliveries. The delivery id header is NOT covered by the HMAC, so
-- the body hash is a second unique key: a captured body replayed under a fresh
-- X-GitHub-Delivery is still refused. Rows are written in the same batch as
-- the transition they caused, so a failed attempt leaves no row and a redelivery retries.
CREATE TABLE webhook_deliveries (
  delivery_id   TEXT PRIMARY KEY,
  body_sha      TEXT NOT NULL UNIQUE,
  event         TEXT NOT NULL,
  action        TEXT,
  submission_id TEXT REFERENCES submissions(id),
  received_at   TEXT NOT NULL
);

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
