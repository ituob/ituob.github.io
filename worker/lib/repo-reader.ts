import { parse as parseYaml } from "yaml";
import { REGISTERS } from "../../src/lib/catalogs.ts";
// Read-only access to files in a GitHub repository, behind an interface (same mock-first approach as
// the OIDC and email seams). Production uses the contents API with a read token from config and fails
// closed without one; tests install a FakeRepoReader. It can never write.
export interface RepoReader {
  /** File text, or null when the path does not exist. Any other failure throws. */
  read(repo: string, path: string, ref?: string): Promise<string | null>;
  /** Entry names of a directory, or null when the directory does not exist. Any other failure throws. */
  list(repo: string, path: string, ref?: string): Promise<string[] | null>;
}
export class RepoReaderNotConfigured extends Error {
  constructor() { super("repository reader is not configured (GITHUB_READ_TOKEN)"); }
}
export class RepoReadFailed extends Error {}
export interface RepoReaderConfig { GITHUB_READ_TOKEN?: string; GITHUB_DATA_REPO?: string }
const repoPattern = /^[\w.-]+\/[\w.-]+$/;
const validRepo = (repo: string) => repoPattern.test(repo) && repo.split("/").every(s => s !== "." && s !== "..");
const pathPattern = /^[A-Za-z0-9_.\-\/ ]+$/;

export class FakeRepoReader implements RepoReader {
  readonly reads: string[] = [];
  constructor(private readonly files: Record<string, string> = {}) {}
  set(repo: string, path: string, text: string) { this.files[`${repo}:${path}`] = text; }
  async read(repo: string, path: string) { this.reads.push(`${repo}:${path}`); return this.files[`${repo}:${path}`] ?? null; }
  async list(repo: string, path: string) {
    this.reads.push(`${repo}:${path}/`);
    const prefix = `${repo}:${path}/`;
    const names = new Set(Object.keys(this.files).filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length).split("/")[0]!));
    return names.size ? [...names] : null;
  }
}

export class GitHubContentsReader implements RepoReader {
  constructor(private readonly token: string, private readonly transport: (url: string, init: RequestInit) => Promise<Response> = fetch) {}
  private async fetchContents(repo: string, path: string, ref: string | undefined, accept: string): Promise<Response> {
    if (!validRepo(repo) || !pathPattern.test(path) || path.split("/").some(s => s === ".." || s === "")) throw new RepoReadFailed("invalid repository path");
    const url = `https://api.github.com/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;
    return this.transport(url, { headers: { Authorization: `Bearer ${this.token}`, Accept: accept, "User-Agent": "ituob-webapp", "X-GitHub-Api-Version": "2022-11-28" } });
  }
  async read(repo: string, path: string, ref?: string): Promise<string | null> {
    const response = await this.fetchContents(repo, path, ref, "application/vnd.github.raw+json");
    if (response.status === 404) return null;
    if (!response.ok) throw new RepoReadFailed(`GitHub read failed (${response.status})`);
    return response.text();
  }
  async list(repo: string, path: string, ref?: string): Promise<string[] | null> {
    const response = await this.fetchContents(repo, path, ref, "application/vnd.github+json");
    if (response.status === 404) return null;
    if (!response.ok) throw new RepoReadFailed(`GitHub read failed (${response.status})`);
    let body: unknown;
    try { body = JSON.parse(await response.text()); } catch { throw new RepoReadFailed("GitHub directory listing is not valid JSON"); }
    if (!Array.isArray(body) || !body.every(e => e && typeof e === "object" && typeof (e as { name?: unknown }).name === "string")) throw new RepoReadFailed("GitHub directory listing has an unexpected shape");
    return body.map(e => (e as { name: string }).name);
  }
}

let override: RepoReader | null = null;
/** Test seam. */
export function setRepoReader(reader: RepoReader | null) { override = reader; }
export function getRepoReader(config: RepoReaderConfig = {}): RepoReader {
  if (override) return override;
  if (!config.GITHUB_READ_TOKEN) throw new RepoReaderNotConfigured();
  return new GitHubContentsReader(config.GITHUB_READ_TOKEN);
}

/** Repository holding the register datasets (`datasets/<dir>/changes/`, `datasets.yaml`) and the `ob-issues/` patch log
 * (ituob/service-publications-docs, the data-ob submodule); GITHUB_DATA_REPO overrides. */
export const DATA_REPO_DEFAULT = "ituob/service-publications-docs";
/**
 * True only when the data repository proves the register has no state: its dataset is listed in
 * `datasets.yaml` with neither a data file nor a data directory, and `datasets/<dir>/changes/` holds
 * nothing. Replay reads exactly those, so any other answer (a missing or malformed index, an unknown or
 * unlisted dataset, a non-boolean flag, an unreadable directory) throws or counts as non-empty: it fails closed.
 */
export async function registerIsEmpty(reader: RepoReader, repo: string, slug: string): Promise<boolean> {
  const dir = REGISTERS.find(r => r.slug === slug)?.seedDatasetSlug;
  if (!dir) throw new RepoReadFailed(`no dataset directory is known for register ${slug}`);
  const text = await reader.read(repo, "datasets.yaml");
  if (text === null) throw new RepoReadFailed("datasets.yaml was not found in the data repository");
  let index: unknown;
  try { index = parseYaml(text); } catch { throw new RepoReadFailed("datasets.yaml is not valid YAML"); }
  const datasets = index && typeof index === "object" ? (index as { datasets?: unknown }).datasets : null;
  if (!Array.isArray(datasets)) throw new RepoReadFailed("datasets.yaml has no datasets list");
  const entry = datasets.find(d => d && typeof d === "object" && (d as { directory?: unknown }).directory === dir) as { has_data_file?: unknown; has_data_directory?: unknown } | undefined;
  if (!entry) throw new RepoReadFailed(`datasets.yaml does not list ${dir}`);
  if (typeof entry.has_data_file !== "boolean" || typeof entry.has_data_directory !== "boolean") throw new RepoReadFailed(`datasets.yaml has no data flags for ${dir}`);
  if (entry.has_data_file || entry.has_data_directory) return false;
  const changes = await reader.list(repo, `datasets/${dir}/changes`);
  return changes === null || changes.length === 0;
}
