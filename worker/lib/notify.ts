// Event emission (#104). Pure recipient rules + the statements that write
// notification rows INSIDE the caller's db.batch, so a rolled-back transition
// leaves no notification and a committed one cannot lack it. Never sends email.
import { ulid } from "./ulid.ts";

export type Level = "all" | "mentions" | "none";

export const STATE_EVENT: Record<string, string> = {
  submitted: "submission.submitted",
  in_review: "submission.in_review",
  changes_requested: "submission.changes_requested",
  approved: "submission.approved",
  rejected: "submission.rejected",
  withdrawn: "submission.withdrawn",
  pr_open: "submission.pr_opened",
  ci_failed: "submission.ci_failed",
  merged: "submission.pr_merged",
  scheduled: "submission.scheduled",
  published: "submission.published",
  // `pr_pending` is deliberately absent: it is committed in the same batch as `approved`
  // (which notifies the proposer) and the system leaves it for `pr_open` within moments.
};
/** Composer removal (`scheduled -> merged`): its own event, never `submission.pr_merged` again. */
const UNSCHEDULED = "submission.unscheduled";
/** Emailed even at level `mentions` (action required, design rule 1 / D3). */
const ACTIONABLE = new Set(["submission.changes_requested", "submission.rejected"]);
/** "To me" events honoured at level `mentions`. */
const TO_ME = new Set(["comment.mention", "comment.reply"]);

/** Whether an email is allowed for this event at this level. `none` is literal. */
export function emailAllowed(kind: string, level: Level): boolean {
  if (level === "none") return false;
  if (level === "all") return true;
  return TO_ME.has(kind) || ACTIONABLE.has(kind);
}

export interface Recipient { userId: string; email: string | null; level: Level; suppressed: boolean }

interface Ctx {
  submissionId: string;
  proposerId: string;
  kind: string;
  actorId: string | null;
  refType: string;
  refId: string;
  payload: Record<string, unknown>;
  at: string;
  /** Explicit recipients (comment events); otherwise derived from the kind. */
  userIds?: string[];
  /** Only inserted if the submission is still at this version (same batch as the transition). */
  version?: number;
}

const ITU_Q = (roles: string) =>
  `SELECT DISTINCT u.id FROM users u JOIN memberships m ON m.user_id=u.id AND m.kind='itu' AND m.status='active'
     JOIN user_roles r ON r.user_id=u.id AND r.role IN (${roles})`;

export async function ituUsers(db: D1Database, admins: boolean, editors: boolean): Promise<string[]> {
  const roles = [editors && "'itu-editor'", admins && "'itu-admin'"].filter(Boolean).join(",");
  if (!roles) return [];
  return (await db.prepare(ITU_Q(roles)).all<{ id: string }>()).results.map((r) => r.id);
}

async function participantIds(db: D1Database, submissionId: string, roles: string[]): Promise<string[]> {
  const q = roles.map((_, i) => `?${i + 2}`).join(",");
  return (await db.prepare(`SELECT DISTINCT user_id FROM submission_participants WHERE submission_id=?1 AND role IN (${q})`).bind(submissionId, ...roles).all<{ user_id: string }>()).results.map((r) => r.user_id);
}

/** Matrix of the design note: who hears about a transition event. */
export async function transitionRecipients(db: D1Database, kind: string, submissionId: string, proposerId: string): Promise<string[]> {
  const P = [proposerId];
  const CW = await participantIds(db, submissionId, ["contact", "watcher"]);
  const R = await ituUsers(db, false, true);
  const A = await ituUsers(db, true, false);
  switch (kind) {
    case "submission.submitted": return [...R, ...(R.length ? [] : A)];
    case "submission.in_review": return [...P, ...(await participantIds(db, submissionId, ["contact"]))];
    case "submission.changes_requested":
    case "submission.rejected": return [...P, ...CW];
    case "submission.approved":
    case "submission.published": return [...P, ...CW, ...A];
    case "submission.pr_opened":
    case "submission.pr_merged": return [...P, ...(await participantIds(db, submissionId, ["watcher"])), ...A];
    case "submission.ci_failed": return [...P, ...R, ...A];
    case "submission.scheduled": return [...P, ...(await participantIds(db, submissionId, ["watcher"]))];
    case "submission.unscheduled": return P;
    case "submission.withdrawn": return [...P, ...R, ...CW];
    case "discussion.closed":
    case "discussion.reopened": return [...P, ...R, ...CW];
    default: return [];
  }
}

/**
 * Statements inserting one notification row per recipient (never the actor),
 * idempotent by dedupe_key. Prefs, address and suppression are applied here so
 * the row records `skipped:*` honestly; the inbox row always exists.
 */
export async function notifyStatements(db: D1Database, c: Ctx, candidates?: string[]): Promise<D1PreparedStatement[]> {
  const ids = [...new Set(candidates ?? c.userIds ?? (await transitionRecipients(db, c.kind, c.submissionId, c.proposerId)))].filter((u) => u !== c.actorId);
  const out: D1PreparedStatement[] = [];
  for (const userId of ids) {
    const u = await db
      .prepare(
        `SELECT u.email AS email, COALESCE(p.level,'all') AS level,
                EXISTS (SELECT 1 FROM email_suppressions s WHERE s.email = u.email) AS suppressed
           FROM users u LEFT JOIN notification_prefs p ON p.user_id=u.id WHERE u.id=?1`,
      )
      .bind(userId)
      .first<{ email: string | null; level: Level; suppressed: number }>();
    if (!u) continue;
    let status = "queued";
    let reason: string | null = null;
    if (!u.email) { status = "skipped"; reason = "skipped:no_address"; }
    else if (!emailAllowed(c.kind, u.level)) { status = "skipped"; reason = "skipped:prefs"; }
    else if (u.suppressed) { status = "skipped"; reason = "skipped:suppressed"; }
    const args = [ulid(), userId, c.submissionId, c.kind, c.refType, c.refId, `${c.kind}:${c.refId}:${userId}`, JSON.stringify(c.payload), c.at, status, reason];
    const guard = c.version === undefined ? "" : ` WHERE EXISTS (SELECT 1 FROM submissions WHERE id=?12 AND version=?13)`;
    out.push(
      db
        .prepare(
          `INSERT INTO notifications (id,user_id,submission_id,kind,ref_type,ref_id,dedupe_key,payload,created_at,email_status,email_reason)
           SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11${guard} ON CONFLICT (dedupe_key) DO NOTHING`,
        )
        .bind(...args, ...(c.version === undefined ? [] : [c.submissionId, c.version])),
    );
  }
  return out;
}

export interface TransitionInfo {
  sub: { id: string; proposer_id: string; register_id: string; slug: string };
  chain: string[];
  actorId: string | null;
  reason: string | null;
  rev: number;
  at: string;
  version: number;
  /** OB issue number the last state refers to (placement in an edition), if any. */
  edition?: number | null;
}

/** The single call `mutate` makes: one event per committed state in the chain. */
export async function transitionNotifications(db: D1Database, t: TransitionInfo): Promise<D1PreparedStatement[]> {
  const out: D1PreparedStatement[] = [];
  for (let i = 1; i < t.chain.length; i++) {
    // Taking an item back out of an edition (scheduled -> merged) changes what the proposer was told
    // ("scheduled"), so it gets its own event rather than a second "pull request merged".
    const unscheduled = t.chain[i - 1] === "scheduled" && t.chain[i] === "merged";
    const kind = unscheduled ? UNSCHEDULED : STATE_EVENT[t.chain[i]!];
    if (!kind) continue;
    const last = i === t.chain.length - 1;
    out.push(
      ...(await notifyStatements(db, {
        submissionId: t.sub.id, proposerId: t.sub.proposer_id, kind, actorId: t.actorId,
        refType: "review_state", refId: `${t.sub.id}:${t.version}:${t.chain[i]}`, at: t.at, version: t.version,
        payload: { register_id: t.sub.register_id, slug: t.sub.slug, from: t.chain[i - 1], to: t.chain[i], rev: t.rev, reason: last ? t.reason : null, edition: last ? (t.edition ?? null) : null },
      })),
    );
  }
  return out;
}

type EmailLocale = "en" | "fr" | "es" | "ru" | "zh" | "ar";
export interface EmailRenderOptions { locale?: string | null; origin?: string }
export interface RenderedEmail { subject: string; text: string; html: string; locale: EmailLocale }
interface EmailNotification { kind: string; payload: string; id: string; submission_id: string }

const EMAIL_COPY = {
  en: {
    edition: "Operational Bulletin No.", event: "Event", actor: "By", reason: "Reason", comment: "Comment", open: "Open submission",
    preferences: "Notification preferences", digest: "Notification digest", fallback: "Submission update",
    events: {
      "submission.submitted": "Submission received", "submission.in_review": "Submission under review",
      "submission.changes_requested": "Changes requested", "submission.approved": "Submission approved",
      "submission.rejected": "Submission rejected", "submission.withdrawn": "Submission withdrawn",
      "submission.pr_opened": "Pull request opened", "submission.ci_failed": "Checks failed",
      "submission.pr_merged": "Pull request merged", "submission.published": "Submission published", "submission.scheduled": "Scheduled in an edition", "submission.unscheduled": "Removed from an edition",
      "comment.mention": "You were mentioned", "comment.reply": "Reply to your comment",
      "comment.created": "New comment", "discussion.closed": "Discussion closed", "discussion.reopened": "Discussion reopened",
    },
  },
  fr: {
    edition: "Bulletin d'exploitation n°", event: "Événement", actor: "Par", reason: "Motif", comment: "Commentaire", open: "Ouvrir la proposition",
    preferences: "Préférences de notification", digest: "Résumé des notifications", fallback: "Mise à jour de la proposition",
    events: {
      "submission.submitted": "Proposition reçue", "submission.in_review": "Proposition en cours d’examen",
      "submission.changes_requested": "Modifications demandées", "submission.approved": "Proposition approuvée",
      "submission.rejected": "Proposition rejetée", "submission.withdrawn": "Proposition retirée",
      "submission.pr_opened": "Demande de fusion ouverte", "submission.ci_failed": "Échec des vérifications",
      "submission.pr_merged": "Demande de fusion intégrée", "submission.published": "Proposition publiée", "submission.scheduled": "Planifiée dans une édition", "submission.unscheduled": "Retirée d’une édition",
      "comment.mention": "Vous avez été mentionné", "comment.reply": "Réponse à votre commentaire",
      "comment.created": "Nouveau commentaire", "discussion.closed": "Discussion fermée", "discussion.reopened": "Discussion rouverte",
    },
  },
  es: {
    edition: "Boletín de Explotación N.°", event: "Evento", actor: "Por", reason: "Motivo", comment: "Comentario", open: "Abrir la presentación",
    preferences: "Preferencias de notificación", digest: "Resumen de notificaciones", fallback: "Actualización de la presentación",
    events: {
      "submission.submitted": "Presentación recibida", "submission.in_review": "Presentación en revisión",
      "submission.changes_requested": "Cambios solicitados", "submission.approved": "Presentación aprobada",
      "submission.rejected": "Presentación rechazada", "submission.withdrawn": "Presentación retirada",
      "submission.pr_opened": "Solicitud de incorporación abierta", "submission.ci_failed": "Verificaciones fallidas",
      "submission.pr_merged": "Solicitud de incorporación integrada", "submission.published": "Presentación publicada", "submission.scheduled": "Programada en una edición", "submission.unscheduled": "Retirada de una edición",
      "comment.mention": "Te han mencionado", "comment.reply": "Respuesta a tu comentario",
      "comment.created": "Nuevo comentario", "discussion.closed": "Discusión cerrada", "discussion.reopened": "Discusión reabierta",
    },
  },
  ru: {
    edition: "Эксплуатационный бюллетень №", event: "Событие", actor: "Автор", reason: "Причина", comment: "Комментарий", open: "Открыть заявку",
    preferences: "Настройки уведомлений", digest: "Сводка уведомлений", fallback: "Обновление заявки",
    events: {
      "submission.submitted": "Заявка получена", "submission.in_review": "Заявка на рассмотрении",
      "submission.changes_requested": "Запрошены изменения", "submission.approved": "Заявка одобрена",
      "submission.rejected": "Заявка отклонена", "submission.withdrawn": "Заявка отозвана",
      "submission.pr_opened": "Запрос на слияние открыт", "submission.ci_failed": "Проверки не пройдены",
      "submission.pr_merged": "Запрос на слияние принят", "submission.published": "Заявка опубликована", "submission.scheduled": "Запланировано в выпуск", "submission.unscheduled": "Исключено из выпуска",
      "comment.mention": "Вас упомянули", "comment.reply": "Ответ на ваш комментарий",
      "comment.created": "Новый комментарий", "discussion.closed": "Обсуждение закрыто", "discussion.reopened": "Обсуждение возобновлено",
    },
  },
  zh: {
    edition: "操作公报第", event: "事件", actor: "作者", reason: "原因", comment: "评论", open: "查看提交内容",
    preferences: "通知偏好设置", digest: "通知摘要", fallback: "提交内容更新",
    events: {
      "submission.submitted": "已收到提交内容", "submission.in_review": "提交内容正在审核",
      "submission.changes_requested": "需要修改", "submission.approved": "提交内容已批准",
      "submission.rejected": "提交内容已拒绝", "submission.withdrawn": "提交内容已撤回",
      "submission.pr_opened": "拉取请求已创建", "submission.ci_failed": "检查失败",
      "submission.pr_merged": "拉取请求已合并", "submission.published": "提交内容已发布", "submission.scheduled": "已排入某期", "submission.unscheduled": "已从某期移除",
      "comment.mention": "有人提到了您", "comment.reply": "您的评论收到回复",
      "comment.created": "新评论", "discussion.closed": "讨论已关闭", "discussion.reopened": "讨论已重新开启",
    },
  },
  ar: {
    edition: "النشرة التشغيلية رقم", event: "الحدث", actor: "بواسطة", reason: "السبب", comment: "التعليق", open: "فتح الطلب",
    preferences: "تفضيلات الإشعارات", digest: "ملخص الإشعارات", fallback: "تحديث الطلب",
    events: {
      "submission.submitted": "تم استلام الطلب", "submission.in_review": "الطلب قيد المراجعة",
      "submission.changes_requested": "طُلبت تعديلات", "submission.approved": "تمت الموافقة على الطلب",
      "submission.rejected": "تم رفض الطلب", "submission.withdrawn": "تم سحب الطلب",
      "submission.pr_opened": "تم فتح طلب دمج", "submission.ci_failed": "فشلت الفحوصات",
      "submission.pr_merged": "تم دمج طلب الدمج", "submission.published": "تم نشر الطلب", "submission.scheduled": "تمت جدولته في عدد", "submission.unscheduled": "أُزيل من عدد",
      "comment.mention": "تمت الإشارة إليك", "comment.reply": "رد على تعليقك",
      "comment.created": "تعليق جديد", "discussion.closed": "تم إغلاق المناقشة", "discussion.reopened": "أُعيد فتح المناقشة",
    },
  },
};

function emailLocale(raw?: string | null): EmailLocale {
  const language = raw?.trim().toLowerCase().split(/[-_]/)[0];
  return language && Object.hasOwn(EMAIL_COPY, language) ? language as EmailLocale : "en";
}

function emailOrigin(raw?: string): string {
  try {
    const url = new URL(raw ?? "https://www.ituob.org");
    if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password) return url.origin;
  } catch { /* Invalid configuration uses the public site. */ }
  return "https://www.ituob.org";
}

function escapeEmailHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function renderEmailEvent(n: EmailNotification, locale: EmailLocale, origin: string) {
  const copy = EMAIL_COPY[locale];
  const p = JSON.parse(n.payload) as Record<string, unknown>;
  const title = `${p.register_id ?? ""} ${p.slug ?? ""}`.trim();
  const event = Object.hasOwn(copy.events, n.kind) ? (copy.events as Record<string, string>)[n.kind]! : copy.fallback;
  const heading = title ? `${title}: ${event}` : event;
  const separator = locale === "fr" ? " : " : ": ";
  const lines = [`${copy.event}${separator}${event}`];
  if (typeof p.edition === "number") lines.push(`${copy.edition}${locale === "zh" ? "" : " "}${p.edition}${locale === "zh" ? "期" : ""}`);
  for (const [key, label] of [["actor_name", copy.actor], ["reason", copy.reason], ["excerpt", copy.comment]]) {
    if (p[key!]) lines.push(`${label}${separator}${String(p[key!])}`);
  }
  const link = `${origin}/me/discussions/?id=${encodeURIComponent(n.submission_id)}`;
  const text = [heading, ...lines, `${copy.open}${separator}${link}`].join("\n");
  const html = `<section><h2>${escapeEmailHtml(heading)}</h2>${lines.map((line) => `<p>${escapeEmailHtml(line).replace(/\n/g, "<br>")}</p>`).join("")}<p><a href="${escapeEmailHtml(link)}">${escapeEmailHtml(copy.open)}</a></p></section>`;
  return { heading, text, html };
}

function finishEmail(subject: string, text: string, html: string, locale: EmailLocale, origin: string): RenderedEmail {
  const preferences = EMAIL_COPY[locale].preferences;
  const link = `${origin}/api/me/notification-prefs`;
  return {
    subject, locale,
    text: `${text}\n\n${preferences}: ${link}`,
    html: `<!doctype html><html lang="${locale}"${locale === "ar" ? ' dir="rtl"' : ""}><head><meta charset="utf-8"><title>${escapeEmailHtml(subject)}</title></head><body>${html}<p><a href="${escapeEmailHtml(link)}">${escapeEmailHtml(preferences)}</a></p></body></html>`,
  };
}

export function renderEmail(n: EmailNotification, options: EmailRenderOptions = {}): RenderedEmail {
  const locale = emailLocale(options.locale);
  const origin = emailOrigin(options.origin);
  const event = renderEmailEvent(n, locale, origin);
  return finishEmail(`[ITU OB] ${event.heading}`, event.text, event.html, locale, origin);
}

export function renderDigestEmail(notifications: EmailNotification[], options: EmailRenderOptions = {}): RenderedEmail {
  const locale = emailLocale(options.locale);
  const origin = emailOrigin(options.origin);
  const heading = EMAIL_COPY[locale].digest;
  const events = notifications.map((n) => renderEmailEvent(n, locale, origin));
  return finishEmail(`[ITU OB] ${heading}`, [heading, ...events.map((event) => event.text)].join("\n\n"),
    `<h1>${escapeEmailHtml(heading)}</h1>${events.map((event) => event.html).join("")}`, locale, origin);
}
