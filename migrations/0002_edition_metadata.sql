-- Independent of the one-open-edition composer: staff can prepare future issue dates.
CREATE TABLE edition_metadata (
  ob_issue_no INTEGER PRIMARY KEY CHECK (ob_issue_no BETWEEN 1 AND 99999),
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  revision INTEGER NOT NULL CHECK (revision > 0),
  scheduled_at TEXT,
  updated_at TEXT NOT NULL
);

-- Reserve exact authored bytes BEFORE an external PR request. A response lost after
-- GitHub accepted the request must be retried against the same immutable revision.
CREATE TABLE edition_metadata_prs (
  ob_issue_no INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  repo TEXT NOT NULL,
  branch TEXT NOT NULL,
  path TEXT NOT NULL,
  content_yaml TEXT NOT NULL,
  pr_number INTEGER,
  commit_sha TEXT,
  pr_url TEXT,
  PRIMARY KEY (ob_issue_no, revision)
);
