import { requireRole } from "./lib/authz.ts";
import { generalMessageArtifact } from "./lib/general-messages.ts";
import { type Route, body, json } from "./lib/http.ts";
import { ConflictError, InvalidError, NotFoundError } from "./lib/membership.ts";
import { getPublisher } from "./lib/publisher.ts";
import { DEFAULT_PATCH_REPO, UpstreamError } from "./lib/submissions.ts";
import { ituSession } from "./submission-routes.ts";

interface Review {
  message_id: string; revision: number; repo: string; branch: string; path: string; content_yaml: string;
  pr_number: number | null; commit_sha: string | null; pr_url: string | null;
}
const read = (db: D1Database, id: string) => db.prepare("SELECT * FROM general_message_prs WHERE message_id=?1 ORDER BY revision DESC LIMIT 1").bind(id).first<Review>();
const path = "^/api/admin/general-messages/([0-9A-HJKMNP-TV-Z]{26})/review$";
export const generalMessagePublicationRoutes: Route[] = [
  { method: "POST", pattern: new RegExp(path), guard: "access", handler: async ({ request, env, access, params }) => {
    requireRole(await ituSession(env, access!), "itu-admin");
    const revision = (await body(request)).expected_revision;
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) throw new InvalidError("expected_revision must name the approved revision");
    const artifact = await generalMessageArtifact(env.DB, params[0]!, revision);
    const repo = env.PATCH_REPO ?? DEFAULT_PATCH_REPO;
    const branch = `rt-msg-${artifact.ob_issue_no}-${artifact.id}-r${revision}`;
    await env.DB.prepare(`INSERT INTO general_message_prs (message_id,revision,repo,branch,path,content_yaml)
      SELECT ?1,?2,?3,?4,?5,?6 FROM general_messages WHERE id=?1 AND revision=?2 AND approved_at IS NOT NULL AND content_yaml=?6
      ON CONFLICT(message_id,revision) DO NOTHING`).bind(artifact.id, revision, repo, branch, artifact.path, artifact.content).run();
    const reserved = await read(env.DB, artifact.id);
    if (!reserved || reserved.revision !== revision || reserved.repo !== repo || reserved.branch !== branch || reserved.path !== artifact.path || reserved.content_yaml !== artifact.content)
      throw new ConflictError("general-message revision changed during review preparation");
    try {
      const pr = await getPublisher(env).openGeneralMessagePr({ repo, branch, path: reserved.path, content: reserved.content_yaml,
        edition: artifact.ob_issue_no, revision, messageId: artifact.id, messageType: artifact.type,
        title: `OB ${artifact.ob_issue_no}: ${artifact.type}`, body: "Review the exact administrator-approved general message. This request does not publish the issue.",
        idempotencyKey: `general-${artifact.id}-r${revision}` });
      await env.DB.prepare(`UPDATE general_message_prs SET pr_number=?3,commit_sha=?4,pr_url=?5
        WHERE message_id=?1 AND revision=?2 AND (pr_number IS NULL OR (pr_number=?3 AND commit_sha=?4))`)
        .bind(artifact.id, revision, pr.prNumber, pr.commitSha, pr.url).run();
      const stored = (await read(env.DB, artifact.id))!;
      if (stored.pr_number !== pr.prNumber || stored.commit_sha !== pr.commitSha) throw new ConflictError("general-message review changed concurrently");
      return json({ ok: true, pr: stored, pending: true }, 202);
    } catch (error) {
      if (error instanceof ConflictError) throw error;
      throw new UpstreamError(error instanceof Error ? error.message : "general-message review unavailable");
    }
  } },
  { method: "GET", pattern: new RegExp(path), guard: "access", handler: async ({ env, access, params }) => {
    requireRole(await ituSession(env, access!), "itu-admin", "itu-editor");
    const stored = await read(env.DB, params[0]!);
    if (!stored) throw new NotFoundError("no general-message review has been prepared");
    if (stored.pr_number === null) return json({ ok: true, pr: stored, pending: true, state: null });
    try {
      const state = await getPublisher(env).getGeneralMessagePullRequest({ repo: stored.repo, prNumber: stored.pr_number, expectedHeadSha: stored.commit_sha ?? "" });
      return json({ ok: true, pr: stored, pending: !state.merged, state });
    } catch (error) { throw new UpstreamError(error instanceof Error ? error.message : "general-message review unavailable"); }
  } },
];
