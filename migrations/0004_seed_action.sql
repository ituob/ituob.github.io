-- Staff-only SEED: the one full-state action (docs/submission-workflow.adoc). The application only
-- accepts it from ITU staff and only for a register whose replayed state is empty; this migration just
-- lets the column hold the value. SQLite cannot alter a CHECK, so the table is rebuilt.
-- Child tables reference submissions(id) by name; their references resolve to the rebuilt table at commit.
PRAGMA defer_foreign_keys = ON;
CREATE TABLE submissions_new (
  id                    TEXT PRIMARY KEY,
  proposer_id           TEXT NOT NULL REFERENCES users(id),
  affiliation_kind      TEXT NOT NULL CHECK (affiliation_kind IN ('itu','member')),
  affiliation_member_id TEXT REFERENCES members(id),
  register_id           TEXT NOT NULL,
  slug                  TEXT NOT NULL,
  action_type           TEXT NOT NULL CHECK (action_type IN ('ADD','SUP','REP','LIR','MOD','DEL','SEED')),
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
INSERT INTO submissions_new SELECT id,proposer_id,affiliation_kind,affiliation_member_id,register_id,slug,action_type,state,
  current_rev,duplicate_of,corrects_id,target_edition,seq,discussion_closed,created_at,updated_at,version FROM submissions;
DROP TABLE submissions;
ALTER TABLE submissions_new RENAME TO submissions;
CREATE INDEX idx_sub_state ON submissions(state, updated_at);
CREATE INDEX idx_sub_proposer ON submissions(proposer_id);
CREATE INDEX idx_sub_register ON submissions(register_id, state);
