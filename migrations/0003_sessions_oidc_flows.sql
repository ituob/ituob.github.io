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
