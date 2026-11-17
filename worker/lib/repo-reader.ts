// Read-only access to files in a GitHub repository, behind an interface (same mock-first approach as
// the OIDC and email seams). Production uses the contents API with a read token from config and fails
// closed without one; tests install a FakeRepoReader. It can never write.
export interface RepoReader {
  /** File text, or null when the path does not exist. Any other failure throws. */
  read(repo: string, path: string, ref?: string): Promise<string | null>;
}
export class RepoReaderNotConfigured extends Error {
  constructor() { super("repository reader is not configured (GITHUB_READ_TOKEN)"); }
}
export class RepoReadFailed extends Error {}
export interface RepoReaderConfig { GITHUB_READ_TOKEN?: string; GITHUB_DATA_REPO?: string }
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const pathPattern = /^[A-Za-z0-9_.\-\/ ]+$/;

export class FakeRepoReader implements RepoReader {
  readonly reads: string[] = [];
  constructor(private readonly files: Record<string, string> = {}) {}
  set(repo: string, path: string, text: string) { this.files[`${repo}:${path}`] = text; }
  async read(repo: string, path: string) { this.reads.push(`${repo}:${path}`); return this.files[`${repo}:${path}`] ?? null; }
}

export class GitHubContentsReader implements RepoReader {
  constructor(private readonly token: string, private readonly transport: (url: string, init: RequestInit) => Promise<Response> = fetch) {}
  async read(repo: string, path: string, ref?: string): Promise<string | null> {
    if (!repoPattern.test(repo) || !pathPattern.test(path) || path.split("/").some(s => s === ".." || s === "")) throw new RepoReadFailed("invalid repository path");
    const url = `https://api.github.com/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;
    const response = await this.transport(url, { headers: { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github.raw+json", "User-Agent": "ituob-webapp", "X-GitHub-Api-Version": "2022-11-28" } });
    if (response.status === 404) return null;
    if (!response.ok) throw new RepoReadFailed(`GitHub read failed (${response.status})`);
    return response.text();
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

/** Repository holding the replayed register snapshots (`snapshots/<slug>/current.json`); GITHUB_DATA_REPO overrides. */
export const SNAPSHOT_REPO_DEFAULT = "ituob/itu-ob-data";
/** True when the register has no current rows. A missing snapshot counts as empty; an unreadable one throws. */
export async function registerIsEmpty(reader: RepoReader, repo: string, slug: string): Promise<boolean> {
  const text = await reader.read(repo, `snapshots/${slug}/current.json`);
  if (text === null) return true;
  let state: { entry_count?: unknown; active_entries?: unknown };
  try { state = JSON.parse(text); } catch { throw new RepoReadFailed("register snapshot is not valid JSON"); }
  const count = typeof state.entry_count === "number" ? state.entry_count : Array.isArray(state.active_entries) ? state.active_entries.length : NaN;
  if (!Number.isFinite(count)) throw new RepoReadFailed("register snapshot has no entry count");
  return count === 0;
}
