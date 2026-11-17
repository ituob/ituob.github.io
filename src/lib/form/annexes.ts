/**
 * Authoring rules for an issue's annexes (`ob-issues/<n>/annexes.yaml`).
 *
 * One module, used by the admin form and by the Worker, so the browser and
 * the server cannot disagree. Wire shape: a mapping of publication id to the
 * annexed position, `{ position_on?, datasets? }`, or null when the position
 * is not known. Validation is self-contained: the pinned ontology does not
 * define annex classes, so these wire rules check every field directly.
 */

export interface AnnexedPositionWire {
  position_on?: string;
  datasets?: Record<string, unknown>;
}
export type AnnexesWire = Record<string, AnnexedPositionWire | null>;
export interface AnnexIssue {
  path: string;
  code: "required" | "type" | "enum" | "mismatch" | "unknown";
  message: string;
}

export const ANNEX_TYPE = "annexes";
export const MAX_ANNEXES = 200;
export const MAX_PUBLICATION_ID = 200;
export const MAX_DATASET_DEPTH = 32;
export const MAX_DATASET_NODES = 10_000;
export const MAX_DATASET_CHARACTERS = 200_000;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A real calendar date or a full ISO timestamp, as the corpus stores them. */
export function isPositionDate(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z)?$/.exec(v);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return false;
  return m[4] === undefined || (Number(m[4]) < 24 && Number(m[5]) < 60 && Number(m[6]) < 60);
}

/** Catalog codes (E212_MNC, RR.25.1) plus the historical prose ids in annexes.
 * Keep legacy spellings explicit rather than permitting arbitrary YAML keys. */
export function publicationIdError(id: string): string | null {
  if (id === "") return "publication id must not be empty";
  if (id !== id.trim()) return "publication id must not start or end with a space";
  if (id.length > MAX_PUBLICATION_ID) return `publication id must be at most ${MAX_PUBLICATION_ID} characters`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff\ud800-\udfff]/u.test(id)) return "publication id must not contain control characters";
  if (!/^[A-Z][A-Z0-9]*(?:[_.][A-Z0-9]+)*$/.test(id)
    && !/^Legal time 201[2-5]$/.test(id)
    && id !== "International Telecommunication Union"
    && id !== "List of Coast Stations and Special Service Stations") return "publication id must be a catalog code or a supported historical publication id";
  return null;
}

/** Inspect iteratively before JSON/YAML serialization can
 * recurse. Budgets include keys, scalar contents and container punctuation. */
function datasetError(dataset: Record<string, unknown>): string | null {
  const pending: { value: unknown; depth: number }[] = [{ value: dataset, depth: 0 }];
  let nodes = 0, characters = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (depth > MAX_DATASET_DEPTH) return `datasets nesting must not exceed ${MAX_DATASET_DEPTH}`;
    if (++nodes > MAX_DATASET_NODES) return `datasets must not exceed ${MAX_DATASET_NODES} values`;
    if (value !== null && typeof value === "object") {
      const entries = Object.entries(value);
      // Bound the queue before adding a wide container's children.
      if (entries.length + nodes + pending.length > MAX_DATASET_NODES) return `datasets must not exceed ${MAX_DATASET_NODES} values`;
      characters += 2 + Math.max(0, entries.length - 1);
      for (const [key, child] of entries) {
        if (!Array.isArray(value)) characters += JSON.stringify(key).length + 1;
        pending.push({ value: child, depth: depth + 1 });
      }
    } else {
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean" && value !== null) return "datasets must contain JSON values";
      if (typeof value === "number" && !Number.isFinite(value)) return "datasets must contain finite numbers";
      characters += JSON.stringify(value).length;
    }
    if (characters > MAX_DATASET_CHARACTERS) return `datasets must not exceed ${MAX_DATASET_CHARACTERS} JSON characters`;
  }
  return null;
}

export function validateAnnexes(value: unknown): AnnexIssue[] {
  if (!isObject(value)) return [{ path: "", code: "type", message: "annexes must be a mapping of publication id to position" }];
  const errors: AnnexIssue[] = [];
  const ids = Object.keys(value);
  if (ids.length > MAX_ANNEXES) errors.push({ path: "", code: "type", message: `at most ${MAX_ANNEXES} annexed publications` });
  for (const id of ids) {
    const at = JSON.stringify(id);
    const idError = publicationIdError(id);
    if (idError) { errors.push({ path: at, code: "type", message: idError }); continue; }
    const entry = value[id];
    if (entry === null) continue;
    if (!isObject(entry)) { errors.push({ path: id, code: "type", message: `${id}: position must be a mapping or null` }); continue; }
    for (const key of Object.keys(entry)) {
      if (key !== "position_on" && key !== "datasets") { errors.push({ path: `${id}.${key}`, code: "unknown", message: `${id}.${key} is not an annex field` }); }
    }
    if ("position_on" in entry && !isPositionDate(entry.position_on)) {
      errors.push({ path: `${id}.position_on`, code: "type", message: `${id}.position_on must be a real date (YYYY-MM-DD) or ISO timestamp` });
    }
    if ("datasets" in entry && !isObject(entry.datasets)) {
      errors.push({ path: `${id}.datasets`, code: "type", message: `${id}.datasets must be an object` });
    }
    if (isObject(entry.datasets)) {
      const message = datasetError(entry.datasets);
      if (message) { errors.push({ path: `${id}.datasets`, code: "type", message }); }
    }
  }
  return errors;
}

/** What `position_on` holds, for a date input: always YYYY-MM-DD. */
export function positionDay(position: string | undefined): string {
  return position && isPositionDate(position) ? position.slice(0, 10) : "";
}

export interface AnnexIndexEntry { issue: number; publication_id: string; position_on: string | null }
export interface AnnexCandidate {
  id: string;
  running: boolean;
  /** Latest annexed position as of the issue, with the issue it was annexed to. */
  position_on: string | null;
  annexed_to: number | null;
}

/**
 * Annexes in force at the start of `issue`: for every publication, its latest
 * annex in an issue before `issue`. Newest issue first. Mirrors the editor's
 * getRunningAnnexesForIssue; the issue being authored is excluded, so its own
 * choices never shadow what it supersedes.
 */
export function runningAnnexes(index: readonly AnnexIndexEntry[], issue: number): AnnexCandidate[] {
  const latest = new Map<string, AnnexIndexEntry>();
  for (const entry of [...index].filter(e => e.issue < issue).sort((a, b) => a.issue - b.issue)) {
    const previous = latest.get(entry.publication_id);
    latest.set(entry.publication_id, { ...entry, position_on: entry.position_on ?? previous?.position_on ?? null });
  }
  return [...latest.values()]
    .sort((a, b) => b.issue - a.issue || a.publication_id.localeCompare(b.publication_id))
    .map(e => ({ id: e.publication_id, running: true, position_on: e.position_on, annexed_to: e.issue }));
}

/** Picker order: running annexes first (newest issue first), then every other known publication id. */
export function pickerCandidates(index: readonly AnnexIndexEntry[], issue: number, query = ""): AnnexCandidate[] {
  const running = runningAnnexes(index, issue);
  const seen = new Set(running.map(c => c.id));
  const others = [...new Set(index.map(e => e.publication_id))].filter(id => !seen.has(id)).sort((a, b) => a.localeCompare(b))
    .map((id): AnnexCandidate => ({ id, running: false, position_on: null, annexed_to: null }));
  const q = query.trim().toLowerCase();
  return [...running, ...others].filter(c => q === "" || c.id.toLowerCase().includes(q));
}

/** Annex a publication: its position defaults to the one it already runs at. Never replaces an existing annex. */
export function annexPublication(wire: AnnexesWire, id: string, running: readonly AnnexCandidate[]): AnnexesWire {
  if (Object.hasOwn(wire, id)) return wire;
  const position = running.find(c => c.id === id)?.position_on;
  return { ...wire, [id]: position ? { position_on: position } : null };
}
export function removeAnnex(wire: AnnexesWire, id: string): AnnexesWire {
  const { [id]: _removed, ...rest } = wire;
  return rest;
}
/** Set, change or clear the annexed position; datasets already stored are kept. */
export function setAnnexPosition(wire: AnnexesWire, id: string, position: string): AnnexesWire {
  if (!Object.hasOwn(wire, id)) return wire;
  const { position_on: old, ...rest } = wire[id] ?? {};
  // A date input edits only the day; retain the timestamp's time and precision.
  const updated = position.length === 10 && old && isPositionDate(old) && old.length > 10
    ? position + old.slice(10) : position;
  const next = position === "" ? rest : { position_on: updated, ...rest };
  return { ...wire, [id]: Object.keys(next).length ? next : null };
}
