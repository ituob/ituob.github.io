/**
 * Issue and dataset loaders.
 *
 * Pure functions, memoized. Read directly from disk; no caching of state
 * outside the build process.
 */
import {
  obIssuesRoot,
  datasetsRoot,
  dataRoot,
  catalogsRoot,
  recommendationsRoot,
  readYaml,
  readYamlOrNull,
  listDirs,
  listFiles,
  memoize,
  join,
} from "./fs";
import type {
  LoadedIssue,
  IssueMeta,
  AnnexesSnapshot,
  RunningAnnexesMessage,
  ApprovedRecommendationsMessage,
  TextualGeneralMessage,
  StructuredAmendment,
  SequencedAmendment,
  TextAmendment,
  PlaceholderAmendment,
  DatasetMetadata,
  ProseMirrorNode,
} from "./types";
import {
  STRUCTURED_GENERAL_TYPES,
  TEXTUAL_GENERAL_TYPES,
  MESSAGE_TYPE_METADATA,
  generalTypesForRec,
  type GeneralMessageType,
} from "./catalogs";

/** Parse an int issue id from a directory name (drops leading zeros). */
function parseIssueId(dir: string): number | null {
  const n = Number.parseInt(dir, 10);
  return Number.isFinite(n) ? n : null;
}

/** List all OB issue ids (sorted ascending). */
export const listIssueIds = memoize((): number[] => {
  return listDirs(obIssuesRoot())
    .map(parseIssueId)
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b);
});

/** Pattern matches NNN-ACTION.yaml. ACTION is uppercased but not constrained
 * to the canonical set, because source data occasionally contains non-standard
 * action codes (e.g. country codes mistakenly used as action types). We
 * preserve them verbatim. */
const ACTION_RE = /^(\d+)-([A-Z0-9]+)$/;

import { existsSync } from "node:fs";
function exists(path: string): boolean {
  return existsSync(path);
}

/** Load a single issue fully. Memoized. */
export const loadIssue = memoize((id: number): LoadedIssue | null => {
  const issueDir = join(obIssuesRoot(), String(id));
  if (!exists(issueDir)) return null;

  const meta = readYaml<IssueMeta>(join(issueDir, "meta.yaml"));
  if (!meta) {
    // Cannot build an issue view without metadata.
    return null;
  }
  const annexes =
    readYamlOrNull<AnnexesSnapshot>(join(issueDir, "annexes.yaml")) ?? {};

  // General messages
  const generalDir = join(issueDir, "general");
  const runningAnnexes =
    readYamlOrNull<RunningAnnexesMessage>(join(generalDir, "running_annexes.yaml"));
  const approvedRecommendations =
    readYamlOrNull<ApprovedRecommendationsMessage>(
      join(generalDir, "approved_recommendations.yaml"),
    );

  const textual: TextualGeneralMessage[] = [];
  for (const t of TEXTUAL_GENERAL_TYPES) {
    const tDir = join(issueDir, t);
    if (!exists(tDir)) continue;
    for (const f of listFiles(tDir).filter((n) => n.endsWith(".yaml"))) {
      const msg = readYamlOrNull<TextualGeneralMessage>(join(tDir, f));
      if (msg) textual.push(msg);
    }
  }

  // Amendments — group by slug
  const structured: Record<string, SequencedAmendment[]> = {};
  const textualAmd: Record<string, TextAmendment> = {};
  const placeholder: Record<string, PlaceholderAmendment> = {};

  for (const entry of listDirs(issueDir)) {
    // Skip non-amendment dirs.
    if (
      entry === "general" ||
      STRUCTURED_GENERAL_TYPES.includes(entry as GeneralMessageType) ||
      TEXTUAL_GENERAL_TYPES.includes(entry as GeneralMessageType)
    ) {
      continue;
    }
    const slug = entry;
    const amdDir = join(issueDir, entry);
    const files = listFiles(amdDir).filter((n) => n.endsWith(".yaml"));
    if (files.length === 0) continue;

    // Textual / placeholder variants
    if (files.includes("text.yaml")) {
      const txt = readYamlOrNull<TextAmendment>(join(amdDir, "text.yaml"));
      if (txt) textualAmd[slug] = txt;
      continue;
    }
    if (files.includes("placeholder.yaml")) {
      const ph = readYamlOrNull<PlaceholderAmendment>(
        join(amdDir, "placeholder.yaml"),
      );
      if (ph) placeholder[slug] = ph;
      continue;
    }

    // Structured: per-action NNN-ACTION.yaml files
    const seqs: SequencedAmendment[] = [];
    for (const f of files) {
      const stem = f.replace(/\.yaml$/, "");
      const m = ACTION_RE.exec(stem);
      if (!m) continue;
      const seq = Number.parseInt(m[1]!, 10);
      const amd = readYaml<StructuredAmendment>(join(amdDir, f));
      if (!amd) continue;
      seqs.push({ ...amd, slug, seq, fileStem: stem });
    }
    if (seqs.length > 0) {
      seqs.sort((a, b) => a.seq - b.seq);
      structured[slug] = seqs;
    }
  }

  return {
    id,
    meta,
    annexes,
    general: {
      runningAnnexes,
      approvedRecommendations,
      textual,
    },
    amendments: { structured, textual: textualAmd, placeholder },
    incomplete: generalIsEmpty(generalDir, textual, runningAnnexes, approvedRecommendations) &&
                 Object.keys(structured).length === 0 &&
                 Object.keys(textualAmd).length === 0 &&
                 Object.keys(placeholder).length === 0,
  };
});

function generalIsEmpty(
  generalDir: string,
  textual: TextualGeneralMessage[],
  runningAnnexes: RunningAnnexesMessage | null,
  approvedRecommendations: ApprovedRecommendationsMessage | null,
): boolean {
  // Mirrors deployed Jekyll's incomplete check: an issue is incomplete
  // when it has no general messages.
  if (runningAnnexes || approvedRecommendations) return false;
  if (textual.length > 0) return false;
  return true;
}

/** Load many issues — convenience. */
export function loadIssues(ids: number[]): (LoadedIssue | null)[] {
  return ids.map((id) => loadIssue(id));
}

/**
 * Compute the running-annexes state at a given issue.
 *
 * Walks every issue from the earliest up to `issueId`, reads each
 * issue's `annexes.yaml`, and accumulates the state: for each
 * annexed publication, tracks the OB number where it was first
 * annexed and the most recent position_on date.
 *
 * Memoized per-issue — the full sweep is O(n) once.
 */
interface RunningAnnexEntry {
  pubId: string;
  slug: string;
  annexed_in: number;
  position_on?: string | Date;
}

const _runningAnnexesCache = new Map<number, RunningAnnexEntry[]>();

export function computeRunningAnnexes(issueId: number): RunningAnnexEntry[] {
  if (_runningAnnexesCache.has(issueId)) {
    return _runningAnnexesCache.get(issueId)!;
  }

  const state = new Map<string, RunningAnnexEntry>();
  const ids = listIssueIds();
  let annexCount = 0;

  for (const id of ids) {
    if (id > issueId) break;

    const annexes = readYamlOrNull<AnnexesSnapshot>(
      join(obIssuesRoot(), String(id), "annexes.yaml"),
    );
    if (!annexes) continue;

    for (const [pubId, info] of Object.entries(annexes)) {
      annexCount++;
      const existing = state.get(pubId);
      if (!existing) {
        state.set(pubId, {
          pubId,
          slug: pubId,
          annexed_in: id,
          position_on: (info as Record<string, unknown>)?.position_on as
            | string
            | Date
            | undefined,
        });
      } else if (info && (info as Record<string, unknown>).position_on) {
        existing.position_on = (info as Record<string, unknown>).position_on as
          | string
          | Date;
      }
    }
  }

  const result: RunningAnnexEntry[] = [];
  for (const entry of state.values()) {
    result.push(entry);
  }

  result.sort((a, b) => b.annexed_in - a.annexed_in);
  _runningAnnexesCache.set(issueId, result);

  if (result.length === 0 && annexCount === 0) {
  }

  return result;
}

/* -- Dataset loaders -------------------------------------------------------- */

/**
 * Load a list publication's metadata from itu-ob-data/lists/{id}/meta.yaml.
 * These use the old naming convention (SR, E180_TNN, F1_IPTS, etc.)
 * that differs from the amendment publication IDs.
 */
const _listMetaCache = new Map<string, { id: string; title?: { en?: string } }>();

export function loadListMetadata(pubId: string): { id: string; title?: { en?: string } } | null {
  if (_listMetaCache.has(pubId)) return _listMetaCache.get(pubId)!;

  // Try several possible locations for the list meta.yaml.
  const root = dataRoot();
  const candidates = [
    join(root, "..", "itu-ob-data", "lists", pubId, "meta.yaml"),
    join(root, "itu-ob-data", "lists", pubId, "meta.yaml"),
    join(root, "..", "lists", pubId, "meta.yaml"),
  ];

  for (const path of candidates) {
    try {
      const meta = readYamlOrNull<{ id: string; title?: { en?: string } }>(path);
      if (meta) {
        _listMetaCache.set(pubId, meta);
        return meta;
      }
    } catch {
      // Continue to next candidate.
    }
  }

  _listMetaCache.set(pubId, null as any);
  return null;
}

export const listDatasetSlugs = memoize((): string[] => {
  return listDirs(datasetsRoot()).sort((a, b) => a.localeCompare(b));
});

export const loadDatasetMetadata = memoize(
  (slug: string): DatasetMetadata | null => {
    return readYamlOrNull<DatasetMetadata>(
      join(datasetsRoot(), slug, "metadata.yaml"),
    );
  },
);

export interface DatasetSchema {
  title?: string;
  description?: string;
  type?: string;
  items?: {
    type?: string;
    properties?: Record<string, { description?: string; type?: string }>;
    required?: string[];
  };
}

export const loadDatasetSchema = memoize(
  (slug: string): DatasetSchema | null => {
    return readYamlOrNull<DatasetSchema>(
      join(datasetsRoot(), slug, "schema-data.yaml"),
    );
  },
);

export const loadDatasetData = memoize(
  (slug: string): Record<string, unknown>[] | null => {
    const data = readYamlOrNull<Record<string, unknown>[] | unknown>(
      join(datasetsRoot(), slug, "data.yaml"),
    );
    if (data == null) return null;
    if (Array.isArray(data)) return data as Record<string, unknown>[];
    return null;
  },
);

/* -- Cross-issue indexes ---------------------------------------------------- */

export interface RecommendationRef {
  code: string;
  version?: string | null;
  issueIds: number[];
  /** English title from catalogs/recommendations.yaml, when available. */
  title?: { en?: string };
  /** Authoritative URL from catalogs/recommendations.yaml, when available. */
  url?: string;
}

export interface RecommendationMeta {
  code: string;
  title?: { en?: string };
  recommendation?: { body?: string; code?: string; version?: string };
}

/** Shape of an entry in catalogs/recommendations.yaml. */
export interface RecommendationCatalogEntry {
  code: string;
  bureau?: string;
  title?: { en?: string };
  version?: string;
  document_path?: string;
  url?: string;
}

/** Shape of an entry in catalogs/registers.yaml. */
export interface RegisterCatalogEntry {
  register_id: string;
  slug: string;
  recommendation: string;
  title: { en?: string };
  key_field?: string;
  classification?: "structured" | "textual";
  parser_class?: string;
  renderer?: string;
  seed_issue?: number;
  seed_path?: string;
  external?: boolean;
}

/**
 * Load a recommendation's metadata by code (e.g. "G.671", "X.509 (2012) Cor 2").
 *
 * Codes are filesystem-safe when used as directory names — the source
 * data uses the code verbatim. Returns null if no metadata exists.
 */
export const loadRecommendationMetadata = memoize(
  (code: string): RecommendationMeta | null => {
    const trimmed = code.trim();
    if (!trimmed) return null;
    return readYamlOrNull<RecommendationMeta>(
      join(recommendationsRoot(), trimmed, "meta.yaml"),
    );
  },
);

/** Load catalogs/recommendations.yaml (SP-parent recommendations). */
export const loadRecommendationCatalog = memoize(
  (): RecommendationCatalogEntry[] => {
    const data = readYamlOrNull<{ recommendations?: RecommendationCatalogEntry[] }>(
      join(catalogsRoot(), "recommendations.yaml"),
    );
    return data?.recommendations ?? [];
  },
);

/** Load catalogs/registers.yaml (the canonical register catalog). */
export const loadRegisterCatalog = memoize(
  (): RegisterCatalogEntry[] => {
    const data = readYamlOrNull<{ registers?: RegisterCatalogEntry[] }>(
      join(catalogsRoot(), "registers.yaml"),
    );
    return data?.registers ?? [];
  },
);

/** Build an index of all referenced Recommendations across all issues. */
export const buildRecommendationIndex = memoize((): Map<string, RecommendationRef> => {
  const idx = new Map<string, RecommendationRef>();

  // Seed with SP-parent recommendations from catalogs/recommendations.yaml.
  // These define Service Publications but are not always referenced from
  // approved_recommendations payloads, so without this seed the
  // /recommendations/{code}/ pages for them would never be generated.
  for (const entry of loadRecommendationCatalog()) {
    idx.set(entry.code, {
      code: entry.code,
      version: entry.version ?? undefined,
      issueIds: [],
      title: entry.title,
      url: entry.url,
    });
  }

  // Build a slug → recommendation-code index from the register catalog
  // so we can credit issues that amend each register to its parent rec.
  const registerSlugToRec = new Map<string, string>();
  for (const reg of loadRegisterCatalog()) {
    if (reg.recommendation) registerSlugToRec.set(reg.slug, reg.recommendation);
  }

  const issueIds = listIssueIds();
  for (const id of issueIds) {
    const issue = loadIssue(id);
    if (!issue) continue;

    // Approval references — every code in approved_recommendations.
    const ar = issue.general.approvedRecommendations;
    if (ar?.payload.items) {
      for (const [code, version] of Object.entries(ar.payload.items)) {
        const trimmed = code.trim();
        const existing = idx.get(trimmed);
        if (existing) {
          existing.issueIds.push(id);
        } else {
          idx.set(trimmed, {
            code: trimmed,
            version: version ?? undefined,
            issueIds: [id],
          });
        }
      }
    }

    // Amendment references — for each register slug with amendments in
    // this issue, credit the issue to the register's parent recommendation.
    const amendedSlugs = new Set<string>([
      ...Object.keys(issue.amendments.structured),
      ...Object.keys(issue.amendments.textual),
      ...Object.keys(issue.amendments.placeholder),
    ]);
    for (const slug of amendedSlugs) {
      const rec = registerSlugToRec.get(slug);
      if (!rec) continue;
      const ref = idx.get(rec);
      if (!ref) continue;
      if (!ref.issueIds.includes(id)) ref.issueIds.push(id);
    }

    // General-message references — credit the issue to every recommendation
    // linked via MESSAGE_TYPE_METADATA. Mirrors the deployed Jekyll page
    // which aggregates telephone_service_2 under E.164, ipns under E.212,
    // sanc under Q.708, etc.
    const seenRecs = new Set<string>();
    for (const m of issue.general.textual) {
      const meta = MESSAGE_TYPE_METADATA[m.type];
      const rec = meta?.recommendation?.code;
      if (!rec || seenRecs.has(rec)) continue;
      seenRecs.add(rec);
      const ref = idx.get(rec);
      if (!ref) continue;
      if (!ref.issueIds.includes(id)) ref.issueIds.push(id);
    }
  }

  // Sort each entry's issueIds descending for stable rendering.
  for (const ref of idx.values()) {
    ref.issueIds.sort((a, b) => b - a);
  }
  return idx;
});

/**
 * For a given recommendation code + OB issue ID, return the slugs of
 * every register under that recommendation that has an amendment in
 * the issue. Used by the per-year archive on /recommendations/{code}/.
 */
export const registersAmendedInIssue = memoize(
  (recCode: string, issueId: number): string[] => {
    const slugsForRec = loadRegisterCatalog()
      .filter((r) => r.recommendation === recCode)
      .map((r) => r.slug);
    if (slugsForRec.length === 0) return [];

    const slugSet = new Set(slugsForRec);
    const issue = loadIssue(issueId);
    if (!issue) return [];

    const amended = new Set<string>([
      ...Object.keys(issue.amendments.structured),
      ...Object.keys(issue.amendments.textual),
      ...Object.keys(issue.amendments.placeholder),
    ]);
    return [...amended].filter((s) => slugSet.has(s)).sort();
  },
);

/**
 * General messages in an issue that are linked to a recommendation code
 * (via MESSAGE_TYPE_METADATA). Returns each message in canonical
 * MESSAGE_TYPE_ORDER. Empty when the rec has no associated general types
 * or when the issue carries none of them.
 */
export function generalMessagesForRec(
  recCode: string,
  issueId: number,
): TextualGeneralMessage[] {
  const types = generalTypesForRec(recCode);
  if (types.length === 0) return [];
  const issue = loadIssue(issueId);
  if (!issue) return [];
  const typeSet = new Set(types);
  return issue.general.textual.filter((m) => typeSet.has(m.type));
}

/** Does this issue carry any general message linked to the rec code? */
export function issueHasGeneralMessagesForRec(
  recCode: string,
  issueId: number,
): boolean {
  return generalMessagesForRec(recCode, issueId).length > 0;
}

/** Find which issues reference a given message type. */
export const issuesWithGeneralType = memoize(
  (type: GeneralMessageType): number[] => {
    const out: number[] = [];
    for (const id of listIssueIds()) {
      const issue = loadIssue(id);
      if (!issue) continue;
      if (type === "running_annexes" && issue.general.runningAnnexes) {
        out.push(id);
      } else if (
        type === "approved_recommendations" &&
        issue.general.approvedRecommendations
      ) {
        out.push(id);
      } else if (
        TEXTUAL_GENERAL_TYPES.includes(type) &&
        issue.general.textual.some((m) => m.type === type)
      ) {
        out.push(id);
      }
    }
    return out;
  },
);

/** All issues that contain amendments to a given dataset slug. */
export const issuesWithDataset = memoize((slug: string): number[] => {
  const out: number[] = [];
  for (const id of listIssueIds()) {
    const issue = loadIssue(id);
    if (!issue) continue;
    if (
      issue.amendments.structured[slug] ||
      issue.amendments.textual[slug] ||
      issue.amendments.placeholder[slug]
    ) {
      out.push(id);
    }
  }
  return out;
});

/** Build an index mapping (slug → most recent annex issue id <= given issue). */
const _lastAnnexByIssueCache = new Map<string, number>();

interface AnnexIndex {
  pubIdToSlug: Map<string, string>;
  // For each issue id, which pubIds were annexed in that specific issue.
  annexedByIssue: Map<number, Set<string>>;
  // For each issue id, the most recent (<= issue) annexation per slug.
  lastAnnexPerIssue: Map<number, Map<string, number>>;
}

const _annexIndex = memoize((): AnnexIndex => {
  const pubIdToSlug = new Map<string, string>();
  const annexedByIssue = new Map<number, Set<string>>();

  for (const id of listIssueIds()) {
    const annexes = readYamlOrNull<AnnexesSnapshot>(
      join(obIssuesRoot(), String(id), "annexes.yaml"),
    );
    if (!annexes) continue;
    const set = new Set<string>();
    for (const pubId of Object.keys(annexes)) {
      const slug = pubId.toLowerCase().replace(/[._]/g, "-");
      pubIdToSlug.set(pubId, slug);
      set.add(slug);
    }
    annexedByIssue.set(id, set);
  }

  // Sweep forward building cumulative last-annex map per issue.
  const lastAnnexPerIssue = new Map<number, Map<string, number>>();
  const running = new Map<string, number>();
  for (const id of listIssueIds()) {
    const annexed = annexedByIssue.get(id);
    if (annexed) {
      for (const slug of annexed) running.set(slug, id);
    }
    // Snapshot
    lastAnnexPerIssue.set(id, new Map(running));
  }

  return { pubIdToSlug, annexedByIssue, lastAnnexPerIssue };
});

export interface AnnexReference {
  issueId: number;
  positionOn: string | null;
}

/**
 * Annex events per publication id, ascending by issue. Built from the
 * memoized issue loader, so indexing the whole corpus costs no extra
 * file reads.
 */
const _annexEventsByPub = memoize((): Map<string, AnnexReference[]> => {
  const byPub = new Map<string, AnnexReference[]>();
  for (const id of listIssueIds()) {
    const annexes = loadIssue(id)?.annexes;
    if (!annexes) continue;
    for (const [pubId, entry] of Object.entries(annexes)) {
      if (!entry) continue;
      const arr = byPub.get(pubId) ?? [];
      arr.push({ issueId: id, positionOn: entry.position_on ?? null });
      byPub.set(pubId, arr);
    }
  }
  return byPub;
});

/**
 * Most recent annex of +pubId+ published in an issue at or before
 * +issueId+ — the "annexed to OB No. N" reference. O(log n) binary
 * search over the per-publication event list.
 */
export const lastAnnexBefore = memoize(
  (issueId: number, pubId: string): AnnexReference | null => {
    const events = _annexEventsByPub().get(pubId);
    if (!events || events.length === 0) return null;
    let lo = 0;
    let hi = events.length - 1;
    let ans: AnnexReference | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (events[mid]!.issueId <= issueId) {
        ans = events[mid]!;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  },
);

/**
 * For a given (issueId, slug) pair, return the cumulative amendment
 * number — how many times this publication has been amended since its
 * most recent annexation, up to and including +issueId+.
 *
 * Matches the deployed Jekyll site's +seq_no+ computation: when an
 * amendment target's publication has been re-annexed, the counter
 * resets at the re-annexation issue. Returns 0 if the publication has
 * never been annexed (matches the deployed "no seq_no" rendering).
 */
export function cumulativeAmendmentNumber(issueId: number, slug: string): number {
  const cacheKey = `${issueId}:${slug}`;
  if (_lastAnnexByIssueCache.has(cacheKey)) {
    return _lastAnnexByIssueCache.get(cacheKey)!;
  }

  const idx = _annexIndex();
  const lastAnnexMap = idx.lastAnnexPerIssue.get(issueId);
  // Mirrors deployed Jekyll logic: amendments are processed BEFORE
  // annexes in the iteration, so the relevant "last annex" for an
  // amendment in issue X is the most recent annex strictly BEFORE X
  // (or in X if X's annex hasn't been processed yet at amendment time).
  // We compute both and use whichever was set BEFORE this issue.
  const lastAnnexIssue = lastAnnexMap?.get(slug) ?? 0;
  // The annex map snapshot at issueId INCLUDES annexes added in
  // issueId itself. For seq_no purposes, the deployed iteration
  // hasn't applied issueId's annex yet when computing the amendment,
  // so we need the snapshot from the PREVIOUS issue.
  const previousIssueId = (() => {
    const ids = listIssueIds();
    const i = ids.indexOf(issueId);
    return i > 0 ? ids[i - 1] : 0;
  })();
  const previousMap = idx.lastAnnexPerIssue.get(previousIssueId);
  const effectiveLastAnnex = previousMap?.get(slug) ?? 0;

  // No annex record → no seq_no. The deployed renders "Amd. to {title}"
  // without a number.
  if (effectiveLastAnnex === 0 && lastAnnexIssue === 0) {
    _lastAnnexByIssueCache.set(cacheKey, 0);
    return 0;
  }

  // Count amendments strictly after the effective last annex.
  const cutoff = effectiveLastAnnex;
  let count = 0;
  for (const id of listIssueIds()) {
    if (id > issueId) break;
    if (id <= cutoff) continue;
    const issue = loadIssue(id);
    if (!issue) continue;
    if (
      issue.amendments.structured[slug] ||
      issue.amendments.textual[slug] ||
      issue.amendments.placeholder[slug]
    ) {
      count++;
    }
  }
  _lastAnnexByIssueCache.set(cacheKey, count);
  return count;
}

/* -- ProseMirror helpers --------------------------------------------------- */

/** Walk all text nodes (useful for plain-text extraction / search). */
export function* walkText(
  node: ProseMirrorNode,
): Generator<{ text: string; marks: ProseMirrorNode["marks"] }> {
  if (node.type === "text" && node.text) {
    yield { text: node.text, marks: node.marks };
  }
  if (node.content) {
    for (const child of node.content) yield* walkText(child);
  }
}
