import { parse, stringify } from "yaml";
import { type AuditRow, auditStatements, sha256 } from "./audit.ts";
import { Forbidden, authorizeEntries, hasRole, isItu } from "./authz.ts";
import { transitionNotifications } from "./notify.ts";
import { systemCommentStatements } from "./system-comment.ts";
import { ConflictError, InvalidError, NotFoundError } from "./membership.ts";
import { type OpenedPr, type PatchPublisher, branchName } from "./publisher.ts";
import type { Session } from "./types.ts";
import { ulid } from "./ulid.ts";
import { ACTION_TYPES, type ActionType, type FieldError, registerKeysOf, submissionTargetErrors, validate } from "./validation.ts";

export class ValidationFailed extends Error {
  constructor(public errors: FieldError[]) {
    super("validation failed");
  }
}
export class UpstreamError extends Error {}

export type State =
  | "draft" | "submitted" | "in_review" | "changes_requested" | "approved" | "rejected"
  | "withdrawn" | "pr_pending" | "pr_open" | "ci_failed" | "merged" | "scheduled" | "published";

export interface Sub {
  id: string;
  proposer_id: string;
  affiliation_kind: "itu" | "member";
  affiliation_member_id: string | null;
  register_id: string;
  slug: string;
  action_type: ActionType;
  state: State;
  current_rev: number;
  target_edition: number | null;
  seq: number | null;
  discussion_closed: number;
  version: number;
  created_at: string;
  updated_at: string;
}

export const DEFAULT_PATCH_REPO = "ituob/itu-ob-data";
const now = () => new Date().toISOString();
const VALIDATOR_VERSION = "stage1-v2";

/** Actor on a transition: a user, or the system (queue consumer). */
export type Actor = { kind: "user"; id: string } | { kind: "system"; id: null } | { kind: "github"; id: null };

/** The only legal moves (design transition table). Anything else is a 409 and writes nothing. */
interface Move {
  from: State[];
  to: State;
  by: "proposer" | "reviewer" | "admin";
  needsReason: boolean;
}
export const MOVES = {
  submit: { from: ["draft"], to: "submitted", by: "proposer", needsReason: false },
  revise: { from: ["changes_requested"], to: "submitted", by: "proposer", needsReason: false },
  withdraw: { from: ["draft", "submitted", "changes_requested"], to: "withdrawn", by: "proposer", needsReason: false },
  start_review: { from: ["submitted"], to: "in_review", by: "reviewer", needsReason: false },
  request_changes: { from: ["in_review"], to: "changes_requested", by: "reviewer", needsReason: true },
  reject: { from: ["in_review"], to: "rejected", by: "reviewer", needsReason: true },
  approve: { from: ["in_review"], to: "approved", by: "reviewer", needsReason: false },
  admin_withdraw: { from: ["approved", "pr_pending", "pr_open", "ci_failed"], to: "withdrawn", by: "admin", needsReason: true },
} as const satisfies Record<string, Move>;
export type MoveName = keyof typeof MOVES;

export async function getSub(db: D1Database, id: string): Promise<Sub> {
  const s = await db.prepare(`SELECT * FROM submissions WHERE id = ?1`).bind(id).first<Sub>();
  if (!s) throw new NotFoundError("unknown submission");
  return s;
}

export function guardedInsert(db: D1Database, table: string, row: Record<string, unknown>, id: string, version: number) {
  const cols = Object.keys(row);
  const n = cols.length;
  return db
    .prepare(
      `INSERT INTO ${table} (${cols.join(",")}) SELECT ${cols.map((_, i) => `?${i + 1}`).join(",")}
       WHERE EXISTS (SELECT 1 FROM submissions WHERE id = ?${n + 1} AND version = ?${n + 2})`,
    )
    .bind(...Object.values(row), id, version);
}
const guard = (id: string, v: number) => ({ sql: "EXISTS (SELECT 1 FROM submissions WHERE id = ?G1 AND version = ?G2)", args: [id, v] });

function revisionRow(sub: { id: string }, rev: number, payload: unknown, errors: FieldError[], by: string, at: string) {
  const payload_yaml = stringify(payload);
  return sha256(payload_yaml).then((payload_sha) => ({
    submission_id: sub.id,
    rev,
    payload_yaml,
    payload_sha,
    validation: JSON.stringify({ stage1: errors, stage2: [], validator_version: VALIDATOR_VERSION, schema_sha: null }),
    created_by: by,
    created_at: at,
  }));
}

function parsePayload(yamlText: string): unknown {
  return parse(yamlText);
}

export async function run(db: D1Database, stmts: D1PreparedStatement[]): Promise<D1Result[]> {
  try {
    return await db.batch(stmts);
  } catch (e) {
    // UNIQUE(audit_log.prev_hash) or a PK clash: a concurrent writer won; nothing was written.
    if (String(e).includes("UNIQUE") || String(e).includes("constraint")) throw new ConflictError("concurrent update, retry");
    throw e;
  }
}

interface MutateOpts {
  from: readonly State[];
  /** Final state. `via` lists intermediate states, each recorded as its own review_state/audit row. */
  to: State;
  via?: State[];
  actor: Actor;
  reason?: string | null;
  auditAction: string;
  detail?: Record<string, unknown>;
  /** Extra submissions columns to set in the same UPDATE. */
  set?: Record<string, unknown>;
  /** Extra guarded statements (guard: version after the update). */
  extra?: (db: D1Database, version: number) => D1PreparedStatement[];
  /** Pure content edit: no review_state row. */
  noHistory?: boolean;
  rev?: number;
  /** Text of the system comment for the final state (default: "State changed from X to Y."). */
  note?: string;
}

/** The one write path for every state change: UPDATE + review_state + audit in one db.batch. */
export async function mutate(db: D1Database, sub: Sub, o: MutateOpts): Promise<Sub> {
  if (!o.from.includes(sub.state)) throw new ConflictError(`illegal transition from ${sub.state}`);
  const t = now();
  const v = sub.version + 1;
  const rev = o.rev ?? sub.current_rev;
  const set = { ...(o.set ?? {}), state: o.to, updated_at: t };
  const cols = Object.keys(set);
  const upd = db
    .prepare(
      `UPDATE submissions SET ${cols.map((c, i) => `${c} = ?${i + 1}`).join(", ")}, version = version + 1
        WHERE id = ?${cols.length + 1} AND state = ?${cols.length + 2} AND version = ?${cols.length + 3}`,
    )
    .bind(...Object.values(set), sub.id, sub.state, sub.version);
  const chain: State[] = [sub.state, ...(o.via ?? []), o.to];
  const stmts: D1PreparedStatement[] = [upd];
  const audit: AuditRow[] = [];
  for (let i = 1; i < chain.length; i++) {
    const last = i === chain.length - 1;
    if (!o.noHistory)
      stmts.push(
        guardedInsert(db, "review_state", {
          submission_id: sub.id, rev, from_state: chain[i - 1], to_state: chain[i],
          actor_id: o.actor.id, actor_kind: o.actor.kind, reason: last ? (o.reason ?? null) : null, at: t,
        }, sub.id, v),
      );
    if (!o.noHistory) audit.push({
      at: t, actor_id: o.actor.id, actor_kind: o.actor.kind, action: o.auditAction, subject_type: "submission",
      subject_id: sub.id, submission_id: sub.id,
      detail: { from: chain[i - 1], to: chain[i], rev, reason: last ? (o.reason ?? null) : null, ...(last ? (o.detail ?? {}) : {}) },
    });
  }
  if (o.noHistory) {
    audit.push({
      at: t, actor_id: o.actor.id, actor_kind: o.actor.kind, action: o.auditAction, subject_type: "submission",
      subject_id: sub.id, submission_id: sub.id, detail: { state: sub.state, rev, ...(o.detail ?? {}) },
    });
  }
  stmts.push(...(o.extra?.(db, v) ?? []));
  // #103-03: a system comment per automated state (system/github actor), in this same batch (guarded by
  // the new version). User-driven moves are already shown as their own actor's history; the existing
  // discussion contract counts only user comments there.
  if (!o.noHistory && o.actor.kind !== "user")
    for (let i = 1; i < chain.length; i++) {
      const last = i === chain.length - 1;
      const text = last && o.note ? o.note : `State changed from ${chain[i - 1]} to ${chain[i]}.${last && o.reason ? ` Reason: ${o.reason}` : ""}`;
      stmts.push(...systemCommentStatements(db, sub.id, v, t, text));
    }
  stmts.push(...(await auditStatements(db, audit, guard(sub.id, v))));
  // #104: one event per committed state, written in this same batch (guarded by the new version).
  if (!o.noHistory)
    stmts.push(...(await transitionNotifications(db, { sub, chain, actorId: o.actor.id, reason: o.reason ?? null, rev, at: t, version: v })));
  const res = await run(db, stmts);
  if (res[0]?.meta.changes !== 1) throw new ConflictError("submission changed concurrently");
  return getSub(db, sub.id);
}

// ---------------------------------------------------------------- member side

function requireUser(session: Session | null): Session {
  if (!session || session.roles.length === 0) throw new Forbidden();
  return session;
}

function parseCreate(b: Record<string, unknown>) {
  const register_id = typeof b.register_id === "string" ? b.register_id : "";
  const slug = typeof b.slug === "string" ? b.slug : "";
  const action_type = b.action_type as ActionType;
  const targetErrors = submissionTargetErrors(register_id, slug);
  if (targetErrors.length) throw new ValidationFailed(targetErrors);
  if (!ACTION_TYPES.includes(action_type)) throw new InvalidError("action_type must be one of " + ACTION_TYPES.join(","));
  if (!b.payload || typeof b.payload !== "object" || Array.isArray(b.payload)) throw new InvalidError("payload must be an object");
  const corrects_id = b.corrects_id === undefined || b.corrects_id === null ? null : String(b.corrects_id);
  if (corrects_id !== null && !/^[0-9A-Z]{26}$/.test(corrects_id)) throw new InvalidError("corrects_id must be a submission id");
  return { register_id, slug, action_type, payload: b.payload as Record<string, unknown>, corrects_id };
}

/** Country binding on every payload write. Unscoped text and LIR are ITU-staff only. */
async function bind(db: D1Database, session: Session, register_id: string, action: ActionType, payload: unknown) {
  const data = (payload as { data?: { _class?: unknown } } | null)?.data;
  if (data?._class === "TextAmendment" && !isItu(session))
    throw new ValidationFailed([{
      path: "data", code: "mismatch",
      message: "Text amendments require an ITU editor or administrator because their country scope cannot be verified",
    }]);
  const keys = registerKeysOf(register_id, payload);
  if (action === "LIR" && !isItu(session)) throw new Forbidden();
  // ITU roles are not key-bound; authorizeEntries needs a non-empty list to be callable.
  if (keys.length === 0 && !isItu(session)) {
    // An invalid class cannot supply a country field. Return its schema errors
    // rather than hiding them behind the valid-but-unscoped payload error.
    const errors = validate({ register_id, action_type: action, payload });
    if (errors.length) throw new ValidationFailed(errors);
    throw new InvalidError("no country/area key found in the entries");
  }
  return authorizeEntries(db, session, keys.length ? keys : ["-"]);
}

export async function createSubmission(db: D1Database, session: Session | null, b: Record<string, unknown>): Promise<Sub> {
  const s = requireUser(session);
  const c = parseCreate(b);
  const snap = await bind(db, s, c.register_id, c.action_type, c.payload);
  // A published submission is corrected by a NEW submission that names it (design "Withdrawal and the undo story").
  if (c.corrects_id) {
    const target = await db.prepare(`SELECT state, register_id FROM submissions WHERE id=?1`).bind(c.corrects_id).first<{ state: State; register_id: string }>();
    if (!target) throw new InvalidError("corrects_id names an unknown submission");
    if (target.state !== "published") throw new ConflictError(`only a published submission is corrected this way; it is ${target.state}`);
    if (target.register_id !== c.register_id) throw new InvalidError("a correction targets the same register");
  }
  const id = ulid();
  const t = now();
  const errors = validate({ register_id: c.register_id, slug: c.slug, action_type: c.action_type, payload: c.payload });
  if (errors.length) throw new ValidationFailed(errors);
  const rev = await revisionRow({ id }, 1, c.payload, errors, s.userId, t);
  const stmts = [
    db
      .prepare(
        `INSERT INTO submissions (id,proposer_id,affiliation_kind,affiliation_member_id,register_id,slug,action_type,state,current_rev,created_at,updated_at,version,corrects_id)
         VALUES (?1,?2,?3,?4,?5,?6,?7,'draft',1,?8,?8,0,?9)`,
      )
      .bind(id, snap.submitted_by, snap.affiliation_kind, snap.affiliation_member_id, c.register_id, c.slug, c.action_type, t, c.corrects_id),
    db
      .prepare(`INSERT INTO submission_revisions (${Object.keys(rev).join(",")}) VALUES (?1,?2,?3,?4,?5,?6,?7)`)
      .bind(...Object.values(rev)),
    db
      .prepare(`INSERT INTO review_state (submission_id,rev,from_state,to_state,actor_id,actor_kind,reason,at) VALUES (?1,1,NULL,'draft',?2,'user',NULL,?3)`)
      .bind(id, s.userId, t),
    ...(await auditStatements(db, [
      {
        at: t, actor_id: s.userId, actor_kind: "user", action: "submission.created", subject_type: "submission",
        subject_id: id, submission_id: id,
        detail: { to: "draft", rev: 1, register_id: c.register_id, action_type: c.action_type, affiliation_kind: snap.affiliation_kind, affiliation_member_id: snap.affiliation_member_id, ...(c.corrects_id ? { corrects_id: c.corrects_id } : {}) },
      },
    ])),
  ];
  await run(db, stmts);
  return getSub(db, id);
}

async function ownSub(db: D1Database, session: Session | null, id: string): Promise<{ s: Session; sub: Sub }> {
  const s = requireUser(session);
  const sub = await getSub(db, id);
  if (sub.proposer_id !== s.userId) throw new Forbidden();
  return { s, sub };
}

async function newRevisionPayload(db: D1Database, s: Session, sub: Sub, b: Record<string, unknown>) {
  const payload = b.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new InvalidError("payload must be an object");
  await bind(db, s, sub.register_id, sub.action_type, payload);
  return payload as Record<string, unknown>;
}

/** Draft edit: a validated immutable revision, no state change, audited. */
export async function editDraft(db: D1Database, session: Session | null, id: string, b: Record<string, unknown>) {
  const { s, sub } = await ownSub(db, session, id);
  if (sub.state !== "draft") throw new ConflictError(`illegal transition from ${sub.state}`);
  const payload = await newRevisionPayload(db, s, sub, b);
  const t = now();
  const errors = validate({ register_id: sub.register_id, slug: sub.slug, action_type: sub.action_type, payload });
  if (errors.length) throw new ValidationFailed(errors);
  const rev = await revisionRow(sub, sub.current_rev + 1, payload, errors, s.userId, t);
  return mutate(db, sub, {
    from: ["draft"], to: "draft", actor: { kind: "user", id: s.userId }, auditAction: "submission.draft_edited",
    noHistory: true, set: { current_rev: rev.rev }, rev: rev.rev, detail: { new_rev: rev.rev },
    extra: (d, v) => [guardedInsert(d, "submission_revisions", rev, sub.id, v)],
  });
}

export async function submitDraft(db: D1Database, session: Session | null, id: string) {
  const { s, sub } = await ownSub(db, session, id);
  if (!(MOVES.submit.from as readonly State[]).includes(sub.state)) throw new ConflictError(`illegal transition from ${sub.state}`);
  const cur = await db
    .prepare(`SELECT payload_yaml FROM submission_revisions WHERE submission_id=?1 AND rev=?2`)
    .bind(sub.id, sub.current_rev)
    .first<{ payload_yaml: string }>();
  const payload = parsePayload(cur!.payload_yaml);
  await bind(db, s, sub.register_id, sub.action_type, payload); // authority re-checked at submit time
  const errors = validate({ register_id: sub.register_id, slug: sub.slug, action_type: sub.action_type, payload });
  if (errors.length) throw new ValidationFailed(errors);
  return mutate(db, sub, { ...MOVES.submit, actor: { kind: "user", id: s.userId }, auditAction: "submission.state" });
}

/** changes_requested -> submitted with a new revision; invalid content is refused and nothing is written. */
export async function reviseSubmission(db: D1Database, session: Session | null, id: string, b: Record<string, unknown>) {
  const { s, sub } = await ownSub(db, session, id);
  if (sub.state !== "changes_requested") throw new ConflictError(`illegal transition from ${sub.state}`);
  const payload = await newRevisionPayload(db, s, sub, b);
  const errors = validate({ register_id: sub.register_id, slug: sub.slug, action_type: sub.action_type, payload });
  if (errors.length) throw new ValidationFailed(errors);
  const t = now();
  const rev = await revisionRow(sub, sub.current_rev + 1, payload, errors, s.userId, t);
  return mutate(db, sub, {
    ...MOVES.revise, actor: { kind: "user", id: s.userId }, auditAction: "submission.state",
    set: { current_rev: rev.rev }, rev: rev.rev,
    extra: (d, v) => [guardedInsert(d, "submission_revisions", rev, sub.id, v)],
  });
}

export async function withdrawOwn(db: D1Database, session: Session | null, id: string, reason: string | null) {
  const { s, sub } = await ownSub(db, session, id);
  return mutate(db, sub, { ...MOVES.withdraw, actor: { kind: "user", id: s.userId }, auditAction: "submission.state", reason });
}

// ---------------------------------------------------------------- reviewer side

function reviewer(session: Session | null, admin = false): Session {
  if (!session) throw new Forbidden();
  if (admin ? !hasRole(session, "itu-admin") : !isItu(session)) throw new Forbidden();
  return session;
}

/** Editors may not review their own submission; an admin may, explicitly, and it is audited. */
function selfReview(s: Session, sub: Sub, b: Record<string, unknown>): Record<string, unknown> {
  if (sub.proposer_id !== s.userId) return {};
  if (hasRole(s, "itu-admin") && b.override_self_review === true) return { override: "self-review-override" };
  throw new Forbidden();
}

function need(b: Record<string, unknown>, move: Move): string | null {
  const r = typeof b.reason === "string" ? b.reason.trim() : "";
  if (move.needsReason && !r) throw new InvalidError("reason required");
  return r || null;
}

export async function reviewMove(
  db: D1Database, session: Session | null, id: string, name: "start_review" | "request_changes" | "reject", b: Record<string, unknown>,
) {
  const s = reviewer(session);
  const sub = await getSub(db, id);
  const detail = selfReview(s, sub, b);
  const reason = need(b, MOVES[name]);
  return mutate(db, sub, { ...MOVES[name], actor: { kind: "user", id: s.userId }, auditAction: "submission.state", reason, detail });
}

export function finalYaml(sub: Sub, edition: number, seq: number, payloadYaml: string): string {
  const p = parsePayload(payloadYaml) as { data: unknown };
  const nnn = String(seq).padStart(3, "0");
  return stringify({
    type: sub.action_type,
    date_requested: null,
    date_active: null,
    ob_issue_no: String(edition),
    reference: `OB-${edition}`,
    identifier: { code: `${edition}-${nnn}` },
    data: p.data,
  });
}

/**
 * in_review -> approved -> pr_pending in one batch: allocates (edition, seq),
 * stores the exact bytes to commit, and records the PR request. The GitHub work
 * happens afterwards in openPr (the "queue consumer"), so a GitHub outage never
 * un-approves anything.
 */
export async function approve(db: D1Database, session: Session | null, id: string, b: Record<string, unknown>, repo: string) {
  const s = reviewer(session);
  const sub = await getSub(db, id);
  const detail = selfReview(s, sub, b);
  if (sub.state !== "in_review") throw new ConflictError(`illegal transition from ${sub.state}`);
  const edition = b.target_edition;
  if (typeof edition !== "number" || !Number.isInteger(edition) || edition < 1) throw new InvalidError("target_edition (positive integer) required");
  const cur = await db
    .prepare(`SELECT payload_yaml FROM submission_revisions WHERE submission_id=?1 AND rev=?2`)
    .bind(sub.id, sub.current_rev)
    .first<{ payload_yaml: string }>();
  const errors = validate({ register_id: sub.register_id, slug: sub.slug, action_type: sub.action_type, payload: parsePayload(cur!.payload_yaml) });
  if (errors.length) throw new ValidationFailed(errors);

  // Gaps in NNN are legal (design); a lost race burns one number, never reuses one.
  const row = await db
    .prepare(
      `INSERT INTO edition_seq (ob_issue_no, slug, next_seq) VALUES (?1, ?2, 2)
       ON CONFLICT (ob_issue_no, slug) DO UPDATE SET next_seq = next_seq + 1
       RETURNING next_seq - 1 AS seq`,
    )
    .bind(edition, sub.slug)
    .first<{ seq: number }>();
  const seq = row!.seq;
  const content = finalYaml(sub, edition, seq, cur!.payload_yaml);
  const branch = branchName(edition, seq, sub.slug, sub.id);
  const path = `ob-issues/${edition}/${sub.slug}/${String(seq).padStart(3, "0")}-${sub.action_type}.yaml`;
  const pr = {
    submission_id: sub.id, rev: sub.current_rev, repo, branch, path, content_yaml: content,
    content_sha: await sha256(content), idempotency_key: `${repo}:${branch}`,
  };
  return mutate(db, sub, {
    from: ["in_review"], to: "pr_pending", via: ["approved"], actor: { kind: "user", id: s.userId },
    auditAction: "submission.state", set: { target_edition: edition, seq },
    detail: { ...detail, target_edition: edition, seq, branch, path, content_sha: pr.content_sha },
    extra: (d, v) => [guardedInsert(d, "submission_prs", pr, sub.id, v)],
  });
}

export interface PrOutcome {
  state: State;
  pr_number: number | null;
  error: string | null;
}

/** The idempotent "consumer": pr_pending -> pr_open. Safe to run any number of times. */
export async function openPr(db: D1Database, publisher: PatchPublisher, id: string): Promise<PrOutcome> {
  const sub = await getSub(db, id);
  const pr = await db
    .prepare(`SELECT * FROM submission_prs WHERE submission_id = ?1 ORDER BY rev DESC LIMIT 1`)
    .bind(id)
    .first<any>();
  if (sub.state === "pr_open") return { state: "pr_open", pr_number: pr?.pr_number ?? null, error: null };
  if (sub.state !== "pr_pending" || !pr) throw new ConflictError(`illegal transition from ${sub.state}`);
  const t = now();
  let opened: OpenedPr | undefined;
  try {
    if ((await sha256(pr.content_yaml)) !== pr.content_sha) throw new Error("content hash mismatch; aborting");
    const op = (opened = await publisher.openPatchPr({
      repo: pr.repo, branch: pr.branch, path: pr.path, content: pr.content_yaml,
      title: `OB-${sub.target_edition}: ${sub.action_type} ${sub.register_id}`,
      body: `Submission ${sub.id} (rev ${pr.rev}). Part of the submission workflow; a human merges.`,
      idempotencyKey: pr.idempotency_key,
    }));
    const after = await mutate(db, sub, {
      from: ["pr_pending"], to: "pr_open", actor: { kind: "system", id: null }, auditAction: "pr.opened",
      detail: { pr_number: op.prNumber, branch: pr.branch, commit_sha: op.commitSha },
      extra: (d, v) => [
        d
          .prepare(
            `UPDATE submission_prs SET pr_number=?3, commit_sha=?4, base_sha=?5, pr_state='open', attempts=attempts+1, last_error=NULL
              WHERE submission_id=?1 AND rev=?2 AND EXISTS (SELECT 1 FROM submissions WHERE id=?1 AND version=?6)`,
          )
          .bind(id, pr.rev, op.prNumber, op.commitSha, op.baseSha, v),
      ],
    });
    // Race fix: the submission may have been withdrawn after the transition committed; never leave that PR open.
    const cur = await getSub(db, id);
    if (cur.state === "withdrawn") return closeOrphanPr(db, publisher, pr, op);
    return { state: after.state, pr_number: op.prNumber, error: null };
  } catch (e) {
    if (e instanceof ConflictError) {
      // A concurrent consumer already finished the same idempotent work.
      const cur = await getSub(db, id);
      if (cur.state === "pr_open") return { state: "pr_open", pr_number: null, error: null };
      // Race fix: an admin withdrew between "PR created" and our transition. The PR exists upstream
      // and the withdrawal saw no pr_number, so nobody else will close it: close it here and audit.
      if (cur.state === "withdrawn" && opened) return closeOrphanPr(db, publisher, pr, opened);
      throw e;
    }
    const msg = String((e as Error).message ?? e).slice(0, 300);
    await run(db, [
      db.prepare(`UPDATE submission_prs SET attempts=attempts+1, last_error=?3 WHERE submission_id=?1 AND rev=?2`).bind(id, pr.rev, msg),
      ...(await auditStatements(db, [
        { at: t, actor_id: null, actor_kind: "system", action: "pr.failed", subject_type: "submission", subject_id: id, submission_id: id, detail: { error: msg, branch: pr.branch } },
      ])),
    ]);
    return { state: "pr_pending", pr_number: null, error: msg };
  }
}

/** Close a PR that was opened for a submission that is already withdrawn; records it either way. */
async function closeOrphanPr(db: D1Database, publisher: PatchPublisher, pr: any, opened: OpenedPr): Promise<PrOutcome> {
  const t = now();
  let error: string | null = null;
  try {
    await publisher.closePatchPr({ repo: pr.repo, branch: pr.branch, prNumber: opened.prNumber });
  } catch (e) {
    error = String((e as Error).message ?? e).slice(0, 300);
  }
  await run(db, [
    db
      .prepare(`UPDATE submission_prs SET pr_number=?3, commit_sha=?4, base_sha=?5, pr_state=?6, attempts=attempts+1, last_error=?7 WHERE submission_id=?1 AND rev=?2`)
      .bind(pr.submission_id, pr.rev, opened.prNumber, opened.commitSha, opened.baseSha, error ? "open" : "closed", error),
    ...(await auditStatements(db, [
      {
        at: t, actor_id: null, actor_kind: "system", action: error ? "pr.orphan_close_failed" : "pr.closed_after_withdraw",
        subject_type: "submission", subject_id: pr.submission_id, submission_id: pr.submission_id,
        detail: { pr_number: opened.prNumber, branch: pr.branch, error },
      },
    ])),
  ]);
  return { state: "withdrawn", pr_number: opened.prNumber, error };
}

/** Admin withdrawal of an approved, not-yet-merged submission. Closes the PR first. */
export async function adminWithdraw(db: D1Database, session: Session | null, id: string, b: Record<string, unknown>, publisher: PatchPublisher) {
  const s = reviewer(session, true);
  const sub = await getSub(db, id);
  const reason = need(b, MOVES.admin_withdraw);
  if (sub.state === "published") throw new ConflictError("a published submission cannot be withdrawn; submit a correction (corrects_id)");
  if (!(MOVES.admin_withdraw.from as readonly State[]).includes(sub.state)) throw new ConflictError(`illegal transition from ${sub.state}`);
  const pr = await db.prepare(`SELECT * FROM submission_prs WHERE submission_id=?1 ORDER BY rev DESC LIMIT 1`).bind(id).first<any>();
  const closing = !!(pr?.pr_number && pr.pr_state === "open");
  // Tell the webhook handler this close is ours (not a human closing the PR).
  const mark = (at: string | null) => db.prepare(`UPDATE submission_prs SET closing_at=?3 WHERE submission_id=?1 AND rev=?2`).bind(id, pr.rev, at).run();
  if (closing) {
    await mark(now());
    try {
      await publisher.closePatchPr({ repo: pr.repo, branch: pr.branch, prNumber: pr.pr_number });
    } catch (e) {
      await mark(null);
      throw new UpstreamError(`could not close the PR: ${String((e as Error).message)}`);
    }
  }
  try {
    return await mutate(db, sub, {
      ...MOVES.admin_withdraw, actor: { kind: "user", id: s.userId }, auditAction: "submission.state", reason,
      extra: (d, v) => [
        d
          .prepare(`UPDATE submission_prs SET pr_state = CASE WHEN pr_number IS NULL THEN pr_state ELSE 'closed' END
                     WHERE submission_id=?1 AND EXISTS (SELECT 1 FROM submissions WHERE id=?1 AND version=?2)`)
          .bind(id, v),
      ],
    });
  } catch (e) {
    if (closing) await mark(null);
    throw e;
  }
}

// ---------------------------------------------------------------- reads

export async function readSubmission(db: D1Database, session: Session | null, id: string) {
  const s = requireUser(session);
  const sub = await getSub(db, id);
  if (sub.proposer_id !== s.userId && !isItu(s)) throw new NotFoundError("unknown submission");
  const revisions = (await db.prepare(`SELECT rev,payload_yaml,payload_sha,validation,created_by,created_at FROM submission_revisions WHERE submission_id=?1 ORDER BY rev`).bind(id).all()).results;
  const history = (await db.prepare(`SELECT from_state,to_state,actor_id,actor_kind,reason,rev,at FROM review_state WHERE submission_id=?1 ORDER BY id`).bind(id).all()).results;
  const pr = await db.prepare(`SELECT repo,branch,path,pr_number,pr_state,attempts,last_error FROM submission_prs WHERE submission_id=?1 ORDER BY rev DESC LIMIT 1`).bind(id).first();
  return { submission: sub, revisions, history, pr };
}

export async function listSubmissions(db: D1Database, session: Session | null, state: string | null, all: boolean) {
  const s = requireUser(session);
  if (all && !isItu(s)) throw new Forbidden();
  const where = [all ? "1=1" : "proposer_id = ?1"];
  const args: unknown[] = all ? [] : [s.userId];
  if (state) { args.push(state); where.push(`state = ?${args.length}`); }
  return (await db.prepare(`SELECT * FROM submissions WHERE ${where.join(" AND ")} ORDER BY created_at, id`).bind(...args).all()).results;
}
