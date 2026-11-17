// GitHub webhook back-channel (docs/submission-workflow.adoc "CI back-channel").
// Every state change goes through `mutate`, the single write path, so audit,
// review_state, #104 notifications and the system comment land in one batch.
// The Worker never merges: a human does, and the `closed + merged` event drives `merged`.
import { auditStatements } from "./audit.ts";
import { ConflictError } from "./membership.ts";
import { PATCH_BRANCH } from "./publisher.ts";
import { type State, type Sub, getSub, guardedInsert, mutate, run } from "./submissions.ts";
import type { Env } from "./types.ts";

export const MAX_BODY_BYTES = 2_000_000;
/** The patch repository's base branch. A PR merged anywhere else is not "published to the data repo". */
// The ONLY main-branch literal in worker code: compared against an inbound webhook ref, never written to (test pins this).
const BASE_BRANCH = "main";
const FAILING = new Set(["failure", "timed_out", "startup_failure"]);
const LIVE: State[] = ["pr_open", "ci_failed"];
const GITHUB = { kind: "github", id: null } as const;

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const ignored = (why: string) => json({ ok: true, status: "ignored", reason: why }, 202);
const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b as ArrayBuffer)].map((x) => x.toString(16).padStart(2, "0")).join("");
const now = () => new Date().toISOString();

/** `sha256=<64 hex>` over the raw body, checked with WebCrypto's constant-time `verify`. */
export async function verifySignature(secret: string, raw: Uint8Array, header: string | null): Promise<boolean> {
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header ?? "");
  if (!m) return false;
  const sig = new Uint8Array(m[1]!.match(/../g)!.map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, sig, raw);
}

export interface Delivery { id: string; bodySha: string; event: string; action: string | null }
export interface PrRow {
  submission_id: string; rev: number; repo: string; branch: string; pr_number: number | null; pr_state: string | null;
  commit_sha: string | null; checks: string | null; closing_at: string | null;
}

/** Rows the transition batch writes with it, so a failed attempt leaves no delivery record and a redelivery retries. */
function deliveryStatement(db: D1Database, d: Delivery, sid: string, version: number) {
  return guardedInsert(db, "webhook_deliveries", {
    delivery_id: d.id, body_sha: d.bodySha, event: d.event, action: d.action, submission_id: sid, received_at: now(),
  }, sid, version);
}

async function isDuplicate(db: D1Database, d: Pick<Delivery, "id" | "bodySha">): Promise<boolean> {
  return !!(await db.prepare(`SELECT 1 AS x FROM webhook_deliveries WHERE delivery_id=?1 OR body_sha=?2`).bind(d.id, d.bodySha).first());
}

/** The PR we created: repo + `rt-sub-*` branch, and the submission's CURRENT PR (not an earlier, closed revision). */
async function ourPr(db: D1Database, repo: unknown, branch: unknown): Promise<{ pr: PrRow; sub: Sub } | null> {
  if (typeof repo !== "string" || typeof branch !== "string" || !PATCH_BRANCH.test(branch)) return null;
  const pr = await db
    .prepare(
      `SELECT p.* FROM submission_prs p WHERE p.repo=?1 AND p.branch=?2
          AND p.rev = (SELECT max(rev) FROM submission_prs WHERE submission_id = p.submission_id)`,
    )
    .bind(repo, branch)
    .first<PrRow>();
  return pr ? { pr, sub: await getSub(db, pr.submission_id) } : null;
}

const prUpdate = (db: D1Database, pr: PrRow, v: number, cols: Record<string, unknown>) => {
  const names = Object.keys(cols);
  return db
    .prepare(
      `UPDATE submission_prs SET ${names.map((c, i) => `${c}=?${i + 3}`).join(", ")}
        WHERE submission_id=?1 AND rev=?2 AND EXISTS (SELECT 1 FROM submissions WHERE id=?1 AND version=?${names.length + 3})`,
    )
    .bind(pr.submission_id, pr.rev, ...Object.values(cols), v);
};

export type Applied =
  | { kind: "applied"; from: State; to: State; anomaly?: string }
  | { kind: "ignored"; why: string };

/**
 * `merged` for a patch PR. Shared by the webhook and the reconciler (which has no delivery:
 * `d` is null), so both take the same guarded transition and a late webhook is a no-op.
 */
export async function applyPrMerged(db: D1Database, pr: PrRow, sub: Sub, i: { number: number; mergeSha: string | null; baseRef: string; d: Delivery | null }): Promise<Applied> {
  if (i.baseRef !== BASE_BRANCH) return { kind: "ignored", why: "merged into a branch other than the base" };
  if (sub.state === "withdrawn") {
    // Withdrawn but merged anyway: the data repo now holds it. Record it; humans decide (revert PR story).
    await run(db, [
      ...(i.d ? [db.prepare(`INSERT INTO webhook_deliveries (delivery_id,body_sha,event,action,submission_id,received_at) VALUES (?1,?2,?3,?4,?5,?6)`).bind(i.d.id, i.d.bodySha, i.d.event, i.d.action, sub.id, now())] : []),
      ...(await auditStatements(db, [{
        at: now(), actor_id: null, actor_kind: "github", action: "github.merged_while_withdrawn", subject_type: "submission",
        subject_id: sub.id, submission_id: sub.id, detail: { pr_number: i.number, merge_sha: i.mergeSha, delivery: i.d?.id ?? null },
      }])),
    ]);
    return { kind: "applied", from: "withdrawn", to: "withdrawn", anomaly: "merged_while_withdrawn" };
  }
  if (!LIVE.includes(sub.state)) return { kind: "ignored", why: `state ${sub.state}` };
  const sha = i.mergeSha;
  const after = await mutate(db, sub, {
    from: LIVE, to: "merged", actor: GITHUB, auditAction: "github.pull_request.merged",
    detail: { pr_number: i.number, merge_sha: sha, delivery: i.d?.id ?? null },
    note: `Pull request #${i.number} was merged${sha ? ` (${sha.slice(0, 7)})` : ""}.`,
    extra: (db2, v) => [prUpdate(db2, pr, v, { pr_state: "merged", merge_sha: sha }), ...(i.d ? [deliveryStatement(db2, i.d, sub.id, v)] : [])],
  });
  return { kind: "applied", from: sub.state, to: after.state };
}

/** A patch PR closed without merging (not by the Worker itself) sends the submission back for revision. */
export async function applyPrClosed(db: D1Database, pr: PrRow, sub: Sub, i: { number: number; d: Delivery | null }): Promise<Applied> {
  if (pr.closing_at) return { kind: "ignored", why: "closed by the Worker" };
  if (!LIVE.includes(sub.state)) return { kind: "ignored", why: `state ${sub.state}` };
  // -> changes_requested, not in_review: re-approval of the same revision would collide on
  // submission_prs(submission_id, rev); a new revision (revise) gets a new branch and PR.
  const reason = `The pull request #${i.number} was closed without merging.`;
  const after = await mutate(db, sub, {
    from: LIVE, to: "changes_requested", actor: GITHUB, auditAction: "github.pull_request.closed", reason,
    detail: { pr_number: i.number, delivery: i.d?.id ?? null }, note: `${reason} Revise the submission to open a new pull request.`,
    extra: (db2, v) => [prUpdate(db2, pr, v, { pr_state: "closed" }), ...(i.d ? [deliveryStatement(db2, i.d, sub.id, v)] : [])],
  });
  return { kind: "applied", from: sub.state, to: after.state };
}

export interface RevertRow {
  submission_id: string; attempt: number; repo: string; branch: string; pr_number: number | null; pr_state: string | null;
}

/** The revert PR we created: repo + branch, and the submission's CURRENT attempt. */
async function ourRevert(db: D1Database, repo: unknown, branch: unknown): Promise<{ rv: RevertRow; sub: Sub } | null> {
  if (typeof repo !== "string" || typeof branch !== "string" || !PATCH_BRANCH.test(branch)) return null;
  const rv = await db
    .prepare(
      `SELECT r.* FROM submission_reverts r WHERE r.repo=?1 AND r.branch=?2
          AND r.attempt = (SELECT max(attempt) FROM submission_reverts WHERE submission_id = r.submission_id)`,
    )
    .bind(repo, branch)
    .first<RevertRow>();
  return rv ? { rv, sub: await getSub(db, rv.submission_id) } : null;
}

const revUpdate = (db: D1Database, rv: RevertRow, v: number, cols: Record<string, unknown>) => {
  const names = Object.keys(cols);
  return db
    .prepare(
      `UPDATE submission_reverts SET ${names.map((c, k) => `${c}=?${k + 3}`).join(", ")}
        WHERE submission_id=?1 AND attempt=?2 AND EXISTS (SELECT 1 FROM submissions WHERE id=?1 AND version=?${names.length + 3})`,
    )
    .bind(rv.submission_id, rv.attempt, ...Object.values(cols), v);
};

/** The revert PR merged: only now does the submission become `withdrawn` (history is never rewritten). */
export async function applyRevertMerged(db: D1Database, rv: RevertRow, sub: Sub, i: { number: number; mergeSha: string | null; baseRef: string; d: Delivery | null }): Promise<Applied> {
  if (i.baseRef !== BASE_BRANCH) return { kind: "ignored", why: "merged into a branch other than the base" };
  if (sub.state !== "merged") {
    // The revert landed but the submission is not where we left it (it was placed in an edition meanwhile):
    // record, do not move; a human decides.
    await run(db, [
      ...(i.d ? [db.prepare(`INSERT INTO webhook_deliveries (delivery_id,body_sha,event,action,submission_id,received_at) VALUES (?1,?2,?3,?4,?5,?6)`).bind(i.d.id, i.d.bodySha, i.d.event, i.d.action, sub.id, now())] : []),
      db.prepare(`UPDATE submission_reverts SET pr_state='merged', merge_sha=?3 WHERE submission_id=?1 AND attempt=?2`).bind(rv.submission_id, rv.attempt, i.mergeSha),
      ...(await auditStatements(db, [{
        at: now(), actor_id: null, actor_kind: "github", action: "github.revert_merged_unexpected_state", subject_type: "submission",
        subject_id: sub.id, submission_id: sub.id, detail: { pr_number: i.number, state: sub.state, merge_sha: i.mergeSha },
      }])),
    ]);
    return { kind: "applied", from: sub.state, to: sub.state, anomaly: "revert_merged_unexpected_state" };
  }
  const after = await mutate(db, sub, {
    from: ["merged"], to: "withdrawn", actor: GITHUB, auditAction: "github.revert.merged",
    reason: "Withdrawn: the revert pull request was merged.",
    detail: { pr_number: i.number, merge_sha: i.mergeSha, delivery: i.d?.id ?? null },
    note: `Revert pull request #${i.number} was merged${i.mergeSha ? ` (${i.mergeSha.slice(0, 7)})` : ""}; the submission is withdrawn.`,
    extra: (db2, v) => [revUpdate(db2, rv, v, { pr_state: "merged", merge_sha: i.mergeSha }), ...(i.d ? [deliveryStatement(db2, i.d, sub.id, v)] : [])],
  });
  return { kind: "applied", from: sub.state, to: after.state };
}

/** The revert PR was closed unmerged: the submission stays `merged`; an admin may request a new revert. */
export async function applyRevertClosed(db: D1Database, rv: RevertRow, sub: Sub, i: { number: number; d: Delivery | null }): Promise<Applied> {
  if (rv.pr_state === "closed" || rv.pr_state === "merged") return { kind: "ignored", why: `revert already ${rv.pr_state}` };
  await run(db, [
    ...(i.d ? [db.prepare(`INSERT INTO webhook_deliveries (delivery_id,body_sha,event,action,submission_id,received_at) VALUES (?1,?2,?3,?4,?5,?6)`).bind(i.d.id, i.d.bodySha, i.d.event, i.d.action, sub.id, now())] : []),
    db.prepare(`UPDATE submission_reverts SET pr_state='closed' WHERE submission_id=?1 AND attempt=?2 AND pr_state='open'`).bind(rv.submission_id, rv.attempt),
    ...(await auditStatements(db, [{
      at: now(), actor_id: null, actor_kind: "github", action: "github.revert.closed_unmerged", subject_type: "submission",
      subject_id: sub.id, submission_id: sub.id, detail: { pr_number: i.number, delivery: i.d?.id ?? null },
    }])),
  ]);
  return { kind: "applied", from: sub.state, to: sub.state };
}

const respond = (r: Applied): Response =>
  r.kind === "ignored"
    ? ignored(r.why)
    : json({ ok: true, status: "applied", from: r.from, to: r.to, ...(r.anomaly ? { anomaly: r.anomaly } : {}) }, 200);

async function onPullRequest(db: D1Database, p: any, d: Delivery): Promise<Response> {
  if (p.action !== "closed") return ignored("action");
  const pull = p.pull_request;
  const repo = p.repository?.full_name;
  if (!pull || pull.head?.repo?.full_name !== repo) return ignored("not a same-repository pull request");
  const merged = pull.merged === true;
  const input = { number: pull.number as number, mergeSha: typeof pull.merge_commit_sha === "string" ? (pull.merge_commit_sha as string) : null, baseRef: String(pull.base?.ref), d };

  const rev = await ourRevert(db, repo, pull.head?.ref);
  if (rev && rev.rv.pr_number === pull.number) {
    return respond(merged ? await applyRevertMerged(db, rev.rv, rev.sub, input) : await applyRevertClosed(db, rev.rv, rev.sub, input));
  }

  const hit = await ourPr(db, repo, pull.head?.ref);
  if (!hit || hit.pr.pr_number !== pull.number) return ignored("not a pull request we created");
  const { pr, sub } = hit;
  // GitHub signs the event body, but the branch can have moved since approval.
  // Only the exact head persisted when this PR was opened is eligible to transition.
  if (typeof pr.commit_sha !== "string" || !/^[0-9a-f]{40}$/i.test(pr.commit_sha)
      || typeof pull.head?.sha !== "string" || pull.head.sha.toLowerCase() !== pr.commit_sha.toLowerCase())
    return ignored("pull request head does not match the approved commit");
  return respond(merged ? await applyPrMerged(db, pr, sub, input) : await applyPrClosed(db, pr, sub, input));
}

async function onChecks(db: D1Database, p: any, event: string, d: Delivery): Promise<Response> {
  if (p.action !== "completed") return ignored("action");
  const o = event === "check_suite" ? p.check_suite : p.check_run;
  if (!o || typeof o.conclusion !== "string") return ignored("no conclusion");
  const branch = event === "check_suite" ? o.head_branch : o.check_suite?.head_branch;
  const key = event === "check_suite" ? `suite:${o.id}` : `run:${o.name}`;
  const hit = await ourPr(db, p.repository?.full_name, branch);
  if (!hit) return ignored("not a pull request we created");
  const { pr, sub } = hit;
  // Stale runs (an older head) and PRs that are no longer open must not move the state.
  if (pr.pr_state !== "open" || !LIVE.includes(sub.state)) return ignored(`state ${sub.state}`);
  if (typeof o.head_sha !== "string" || o.head_sha.toLowerCase() !== (pr.commit_sha ?? "").toLowerCase()) return ignored("head_sha is not the PR's commit");

  const results: Record<string, string> = pr.checks ? JSON.parse(pr.checks) : {};
  const next = { ...results, [key]: o.conclusion };
  const failing = Object.keys(next).filter((k) => FAILING.has(next[k]!));
  const checks = JSON.stringify(next);
  const base = { actor: GITHUB, detail: { pr_number: pr.pr_number, check: key, conclusion: o.conclusion, delivery: d.id } } as const;
  const extra = (db2: D1Database, v: number) => [prUpdate(db2, pr, v, { checks }), deliveryStatement(db2, d, sub.id, v)];

  if (sub.state === "pr_open" && failing.length) {
    const reason = `Checks failed: ${failing.join(", ")}`;
    const after = await mutate(db, sub, { ...base, from: ["pr_open"], to: "ci_failed", auditAction: "github.checks.failed", reason, note: `${reason}.`, extra });
    return json({ ok: true, status: "applied", from: sub.state, to: after.state }, 200);
  }
  if (sub.state === "ci_failed" && !failing.length && o.conclusion === "success") {
    const after = await mutate(db, sub, { ...base, from: ["ci_failed"], to: "pr_open", auditAction: "github.checks.recovered", note: "Checks are passing again.", extra });
    return json({ ok: true, status: "applied", from: sub.state, to: after.state }, 200);
  }
  if (checks === (pr.checks ?? "{}")) return ignored("no change");
  // Record the result without a state change (still one audited, versioned write).
  await mutate(db, sub, { ...base, from: [sub.state], to: sub.state, auditAction: "github.checks.recorded", noHistory: true, extra });
  return json({ ok: true, status: "applied", from: sub.state, to: sub.state }, 200);
}

export async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const secret = env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return json({ error: "webhook not configured" }, 503); // fail closed
  const declared = Number(request.headers.get("Content-Length") ?? 0);
  if (declared > MAX_BODY_BYTES) return json({ error: "payload too large" }, 413);
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.byteLength > MAX_BODY_BYTES) return json({ error: "payload too large" }, 413);
  // Authenticate before parsing a single byte.
  if (!(await verifySignature(secret, raw, request.headers.get("X-Hub-Signature-256")))) return json({ error: "invalid signature" }, 401);

  const id = request.headers.get("X-GitHub-Delivery");
  const event = request.headers.get("X-GitHub-Event");
  if (!id || !event || id.length > 100) return json({ error: "missing delivery or event header" }, 400);
  let payload: any;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return json({ error: "body is not JSON" }, 400);
  }
  if (!payload || typeof payload !== "object") return json({ error: "body is not a JSON object" }, 400);
  if (event === "ping") return json({ ok: true, status: "pong" }, 200);

  const d: Delivery = { id, bodySha: hex(await crypto.subtle.digest("SHA-256", raw)), event, action: typeof payload.action === "string" ? payload.action : null };
  // The delivery id header is not covered by the signature, so the body hash is the real replay key.
  if (await isDuplicate(env.DB, d)) return json({ ok: true, status: "duplicate" }, 200);
  try {
    if (event === "pull_request") return await onPullRequest(env.DB, payload, d);
    if (event === "check_suite" || event === "check_run") return await onChecks(env.DB, payload, event, d);
    return ignored("event");
  } catch (e) {
    if (e instanceof ConflictError) {
      // A concurrent delivery of the same event won, or the submission moved: duplicate if recorded.
      if (await isDuplicate(env.DB, d)) return json({ ok: true, status: "duplicate" }, 200);
      return json({ error: "conflict, redeliver" }, 409);
    }
    throw e;
  }
}
