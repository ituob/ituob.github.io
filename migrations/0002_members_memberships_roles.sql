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
