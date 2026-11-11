import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach } from "vitest";

beforeAll(async () => {
  await applyD1Migrations(env.DB, (env as any).TEST_MIGRATIONS);
  // Stand-in for #103's submission store: it only exists to prove history is
  // preserved (affiliation is a snapshot, not a join to live membership).
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS test_submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, submitted_by TEXT NOT NULL REFERENCES users(id), affiliation_kind TEXT NOT NULL, affiliation_member_id TEXT REFERENCES members(id), register_key TEXT NOT NULL, body TEXT)",
  );
});

beforeEach(async () => {
  for (const t of ["webhook_deliveries", "notification_counters", "email_suppressions", "notification_prefs", "notifications", "submission_participants", "discussion_state_log", "comment_revisions", "comments", "handle_history", "user_handles", "audit_log", "submission_prs", "review_state", "submission_revisions", "edition_seq", "submissions", "sessions", "oidc_flows", "test_submissions", "membership_events", "user_roles", "memberships", "members", "users"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
});
