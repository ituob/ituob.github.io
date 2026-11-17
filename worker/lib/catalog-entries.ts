// Service-publication (register) create/edit for ITU staff. The catalogs live
// in the catalog repository (service-publications-docs), so a change is a
// review PR against catalogs/registers.yaml; nothing is stored in D1 and the
// default branch is never written. Validation is the module the form uses.

import { applyRegisterEntry, parseRecommendations, parseRegisters } from "../../src/lib/form/catalog-yaml.ts";
import { normalizeCatalogEntry, validateCatalogEntry, type CatalogContext, type CatalogEntryInput } from "../../src/lib/form/catalog-entry.ts";
import { requireRole } from "./authz.ts";
import { ConflictError, InvalidError, NotFoundError } from "./membership.ts";
import { CATALOG_PATH, DEFAULT_CATALOG_REPO, PublisherNotConfigured, getPublisher, type CatalogSnapshot } from "./publisher.ts";
import { UpstreamError, ValidationFailed } from "./submissions.ts";
import type { Env, Session } from "./types.ts";

export interface CatalogRegister { id: string; slug: string | null; title: Record<string, string>; url: string | null; recommendation: string | null; classification: string | null }
export interface CatalogView { repo: string; base_sha: string; registers: CatalogRegister[]; recommendations: { code: string; title: Record<string, string> }[] }

const staff = (session: Session) => requireRole(session, "itu-admin", "itu-editor");
const repoOf = (env: Env) => env.CATALOG_REPO ?? DEFAULT_CATALOG_REPO;

async function snapshot(env: Env): Promise<CatalogSnapshot> {
  try { return await getPublisher(env).readCatalog({ repo: repoOf(env) }); }
  catch (e) {
    if (e instanceof PublisherNotConfigured) throw new UpstreamError("the catalog repository is not configured");
    throw new UpstreamError("could not read the catalogs from GitHub");
  }
}

function view(snap: CatalogSnapshot): { view: CatalogView; ctx: CatalogContext } {
  const rows = parseRegisters(snap.registers.text);
  const recs = parseRecommendations(snap.recommendations.text);
  const str = (v: unknown) => typeof v === "string" ? v : null;
  const registers = rows.map((r) => ({
    id: String(r.register_id), slug: str(r.slug), title: (r.title && typeof r.title === "object" ? r.title : {}) as Record<string, string>,
    url: str(r.url), recommendation: str(r.recommendation), classification: str(r.classification),
  }));
  return {
    view: { repo: snap.repo, base_sha: snap.baseSha, registers, recommendations: recs.map((r) => ({ code: r.code, title: r.title ?? {} })) },
    ctx: { existingIds: registers.map((r) => r.id), existingSlugs: registers.flatMap((r) => r.slug ? [r.slug] : []), recommendations: recs.map((r) => r.code) },
  };
}

export async function readCatalogView(env: Env, session: Session): Promise<CatalogView> {
  staff(session);
  return view(await snapshot(env)).view;
}

async function digest(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...bytes].slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function shape(raw: Record<string, unknown>): CatalogEntryInput {
  const title = raw.title;
  if (typeof raw.id !== "string" || !title || typeof title !== "object" || Array.isArray(title) || Object.values(title).some((v) => typeof v !== "string")
    || (raw.url != null && typeof raw.url !== "string") || typeof raw.recommendation !== "string" || (raw.key_field != null && typeof raw.key_field !== "string"))
    throw new InvalidError("expected {id, title: {lang: text}, url?, recommendation, key_field?}");
  return { id: raw.id, title: title as Record<string, string>, url: raw.url as string | null | undefined, recommendation: raw.recommendation, ...(raw.key_field == null ? {} : { key_field: raw.key_field as string }) };
}

/** Create (`original` undefined) or edit a register: validate, then open one review PR. */
export async function proposeCatalogEntry(env: Env, session: Session, raw: Record<string, unknown>, original?: string) {
  staff(session);
  const input = normalizeCatalogEntry(shape(raw));
  const snap = await snapshot(env);
  const { ctx } = view(snap);
  const issues = validateCatalogEntry(input, ctx, original);
  const invalid = issues.filter((i) => i.code !== "duplicate");
  if (invalid.some((i) => i.code === "unknown" && i.path === "id")) throw new NotFoundError(invalid.find((i) => i.path === "id")!.message);
  if (invalid.length) throw new ValidationFailed(invalid.map((i) => ({ path: i.path, code: i.code as "required", message: i.message })));
  if (issues.length) throw new ConflictError(issues[0]!.message);

  const content = applyRegisterEntry(snap.registers.text, input, original);
  const branch = `rt-cat-${await digest(`${snap.registers.blobSha}\n${content}`)}`;
  const verb = original === undefined ? "Add" : "Update";
  try {
    const pr = await getPublisher(env).openCatalogPr({
      repo: snap.repo, branch, path: CATALOG_PATH, content, baseBlobSha: snap.registers.blobSha, idempotencyKey: branch,
      title: `${verb} service publication ${input.id}`,
      body: `## Summary\n\n${verb} the ${input.id} entry in \`${CATALOG_PATH}\`, requested through the ITU staff catalog form. Only that entry changes.\n\nA structured register also needs a parser class and renderer in code; a register added here is textual.`,
    });
    return { pr: { number: pr.prNumber, url: pr.url, branch, commit_sha: pr.commitSha }, entry: input };
  } catch (e) {
    if (e instanceof PublisherNotConfigured) throw new UpstreamError("the catalog repository is not configured");
    if (e instanceof Error && e.message === "Catalog changed since it was read") throw new ConflictError("The catalog changed while you were editing. Reload and retry.");
    throw new UpstreamError("could not open the catalog review PR");
  }
}
