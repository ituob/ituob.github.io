-- #102 minimal users table (identity 'sub' as key). Sessions/oidc tables
-- belong to #102's own implementation and are not created here.
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT,
  display_name  TEXT,
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);
CREATE INDEX users_email ON users (lower(email));
