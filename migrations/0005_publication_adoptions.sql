-- ITU adoption of a generated PDF (ituob.github.io#106). One row per adoption,
-- pinned to the exact sha256 of the rendered file: a re-render has a different
-- sha256 and is therefore not adopted. Revocation stamps revoked_at/revoked_by
-- (the row is kept); every adoption and revocation also appends an audit_log row.
CREATE TABLE publication_adoptions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  standard      TEXT NOT NULL,
  edition_year  INTEGER NOT NULL,
  language      TEXT NOT NULL,
  sha256        TEXT NOT NULL CHECK (length(sha256) = 64),
  adopted_by    TEXT NOT NULL REFERENCES users(id),
  adopted_at    TEXT NOT NULL,
  revoked_by    TEXT REFERENCES users(id),
  revoked_at    TEXT,
  CHECK ((revoked_by IS NULL) = (revoked_at IS NULL))
);
-- At most one live adoption per exact file.
CREATE UNIQUE INDEX idx_adoption_live
  ON publication_adoptions(standard, edition_year, language, sha256) WHERE revoked_at IS NULL;
