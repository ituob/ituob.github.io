ALTER TABLE users ADD COLUMN locale TEXT;
ALTER TABLE notification_prefs ADD COLUMN delivery TEXT NOT NULL DEFAULT 'immediate'
  CHECK (delivery IN ('immediate','digest'));
ALTER TABLE notifications ADD COLUMN digest_key TEXT;
CREATE INDEX idx_n_digest_key ON notifications(digest_key);

CREATE TABLE recorded_emails (
  id          TEXT PRIMARY KEY,
  to_address  TEXT NOT NULL,
  subject     TEXT NOT NULL,
  text_body   TEXT NOT NULL,
  html_body   TEXT NOT NULL,
  locale      TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
