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

-- Set by an admin withdrawal just before it closes the PR, so the "closed"
-- webhook our own close produces is not mistaken for a human closing the PR.
ALTER TABLE submission_prs ADD COLUMN closing_at TEXT;

-- DEVIATION: comment_revisions.edited_by becomes nullable (system comments have
-- no author). SQLite cannot drop NOT NULL in place; rebuild. Nothing references this table.
CREATE TABLE comment_revisions_new (
  comment_id TEXT NOT NULL REFERENCES comments(id),
  rev        INTEGER NOT NULL,
  body       TEXT NOT NULL,
  mentions   TEXT NOT NULL,
  edited_by  TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (comment_id, rev)
);
INSERT INTO comment_revisions_new SELECT comment_id, rev, body, mentions, edited_by, created_at FROM comment_revisions;
DROP TABLE comment_revisions;
ALTER TABLE comment_revisions_new RENAME TO comment_revisions;
