import { assertPatchBranch, assertMetadataRequest, assertMessageRequest, METADATA_BRANCH, MESSAGE_BRANCH, PublisherNotConfigured } from "./publisher.ts";
import type { OpenPatchPrRequest, OpenMetadataPrRequest, OpenGeneralMessagePrRequest, OpenRevertPrRequest, OpenedPr, PatchPublisher, PinBump, PinBumpRequest, PublisherConfig, PullRequestState } from "./publisher.ts";

type Json = Record<string, any>;
export type GitHubTransport = (input: string, init: RequestInit) => Promise<Response>;
class GitHubFailure extends Error {
  constructor(readonly status: number) { super(`GitHub publisher request failed (${status})`); }
}
const shaPattern = /^[a-f0-9]{40}$/;
const actionPath = /^ob-issues\/[1-9]\d*\/[a-z0-9]+(?:-[a-z0-9]+)*\/\d{3}-(?:ADD|SUP|REP|LIR|MOD|DEL)\.yaml$/;
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const encode = encodeURIComponent;
function base64(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}
function url64(value: Uint8Array): string { return base64(value).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_"); }
async function fingerprint(value: unknown): Promise<string> {
  return url64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)))));
}
function requireSha(value: string): string {
  if (!shaPattern.test(value)) throw new Error("Invalid GitHub commit SHA");
  return value;
}

/** Only creates immutable objects, new owned refs and review PRs; never updates a ref. */
export class GitHubAppPatchPublisher implements PatchPublisher {
  private token?: { value: string; expires: number };
  private tokenRequest?: Promise<string>;
  constructor(private readonly config: PublisherConfig = {}, private readonly transport: GitHubTransport = fetch) {}

  private configured(): void {
    const c = this.config;
    if (!c.GITHUB_APP_ID || !c.GITHUB_APP_PRIVATE_KEY || !c.GITHUB_APP_INSTALLATION_ID || !c.PATCH_REPO || !repoPattern.test(c.PATCH_REPO)) throw new PublisherNotConfigured();
    if (!/^\d+$/.test(c.GITHUB_APP_ID) || !/^\d+$/.test(c.GITHUB_APP_INSTALLATION_ID)) throw new PublisherNotConfigured();
  }
  private dataRepo(repo: string): string {
    this.configured();
    if (repo !== this.config.PATCH_REPO) throw new Error("Repository is not the configured patch repository");
    return `/repos/${repo}`;
  }
  private async request(path: string, method = "GET", body?: unknown, token?: string): Promise<Json> {
    const auth = token ?? await this.accessToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await this.transport(`https://api.github.com${path}`, {
        method, redirect: "error", signal: controller.signal,
        headers: { Authorization: `Bearer ${auth}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10", "User-Agent": "ituob-patch-publisher", "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new GitHubFailure(response.status);
      return response.status === 204 ? {} : await response.json() as Json;
    } catch (error) {
      if (error instanceof GitHubFailure) throw error;
      throw new GitHubFailure(0);
    } finally { clearTimeout(timer); }
  }
  private async optional(path: string): Promise<Json | null> {
    try { return await this.request(path); } catch (error) {
      if (error instanceof GitHubFailure && error.status === 404) return null;
      throw error;
    }
  }
  private async accessToken(): Promise<string> {
    this.configured();
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value;
    if (this.tokenRequest) return this.tokenRequest;
    this.tokenRequest = this.createToken();
    try { return await this.tokenRequest; } finally { this.tokenRequest = undefined; }
  }
  private async createToken(): Promise<string> {
    try {
      const c = this.config;
      const pem = c.GITHUB_APP_PRIVATE_KEY!;
      if (!pem.includes("-----BEGIN PRIVATE KEY-----")) throw new Error();
      const raw = atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, ""));
      const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(raw, ch => ch.charCodeAt(0)), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
      const now = Math.floor(Date.now() / 1000);
      const head = url64(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
      const payload = url64(new TextEncoder().encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: c.GITHUB_APP_ID })));
      const unsigned = `${head}.${payload}`;
      const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
      const result = await this.request(`/app/installations/${c.GITHUB_APP_INSTALLATION_ID}/access_tokens`, "POST", {}, `${unsigned}.${url64(new Uint8Array(signature))}`);
      const expires = Date.parse(result.expires_at);
      if (typeof result.token !== "string" || !Number.isFinite(expires) || expires <= Date.now()) throw new Error();
      this.token = { value: result.token, expires };
      return result.token;
    } catch (error) {
      if (error instanceof GitHubFailure) throw error;
      throw new Error("GitHub App authentication failed");
    }
  }
  private patch(req: OpenPatchPrRequest | OpenRevertPrRequest): string {
    const repo = this.dataRepo(req.repo);
    assertPatchBranch(req.branch);
    if (!actionPath.test(req.path)) throw new Error("Invalid patch action path");
    if (!req.idempotencyKey) throw new Error("Missing idempotency key");
    return repo;
  }
  private async defaultRef(repo: string): Promise<{ ref: string; sha: string }> {
    const metadata = await this.request(repo);
    const branch = await this.request(`${repo}/git/ref/heads/${encode(metadata.default_branch)}`);
    return { ref: metadata.default_branch, sha: requireSha(branch.object.sha) };
  }
  private marker(branch: string, hash: string): string { return `ituob-publisher ${branch} ${hash}`; }
  private async commit(repo: string, sha: string): Promise<Json> { return this.request(`${repo}/git/commits/${requireSha(sha)}`); }
  private async makeCommit(repo: string, parent: string, entry: Json, message: string): Promise<string> {
    const base = await this.commit(repo, parent);
    const tree = await this.request(`${repo}/git/trees`, "POST", { base_tree: base.tree.sha, tree: [entry] });
    const commit = await this.request(`${repo}/git/commits`, "POST", { message, tree: tree.sha, parents: [parent] });
    return requireSha(commit.sha);
  }
  private async createRef(repo: string, branch: string, sha: string): Promise<string> {
    try {
      await this.request(`${repo}/git/refs`, "POST", { ref: `refs/heads/${branch}`, sha });
      return sha;
    } catch (error) {
      // A racing creator may have won; never move its ref.
      if (!(error instanceof GitHubFailure) || error.status !== 422) throw error;
      const existing = await this.request(`${repo}/git/ref/heads/${encode(branch)}`);
      return requireSha(existing.object.sha);
    }
  }
  private async verifyChange(repo: string, sha: string, path: string, message: string, content?: string, gitlink?: string): Promise<Json> {
    const commit = await this.commit(repo, sha);
    if (commit.message !== message || commit.parents?.length !== 1) throw new Error("Existing branch is not the requested publisher commit");
    const parent = requireSha(commit.parents[0].sha);
    const diff = await this.request(`${repo}/compare/${parent}...${sha}`);
    if (diff.files?.length !== 1 || diff.files[0].filename !== path || diff.files[0].previous_filename) throw new Error("Publisher branch contains unrelated changes");
    if (content === undefined && gitlink === undefined) {
      if (diff.files[0].status !== "removed") throw new Error("Revert branch does not delete the patch");
    } else {
      const file = await this.request(`${repo}/contents/${path.split("/").map(encode).join("/")}?ref=${sha}`);
      if (gitlink !== undefined) {
        if (file.sha !== gitlink || !this.gitlinkMatches(file.submodule_git_url)) throw new Error("Pin branch has a different gitlink");
      } else if (file.encoding !== "base64" || file.content.replace(/\s/g, "") !== base64(new TextEncoder().encode(content!))) throw new Error("Patch bytes differ on existing branch");
    }
    return commit;
  }
  private async pull(repo: string, branch: string, base: string, title: string, body: string, sha: string): Promise<Json> {
    const owner = repo.split("/")[2];
    const query = `${repo}/pulls?state=all&head=${encode(`${owner}:${branch}`)}&base=${encode(base)}&per_page=100`;
    let prs = await this.request(query) as unknown as Json[];
    if (!prs.length) {
      try { return this.validatePr(await this.request(`${repo}/pulls`, "POST", { head: branch, base, title, body }), repo, branch, base, sha); }
      catch (error) {
        if (!(error instanceof GitHubFailure) || error.status !== 422) throw error;
        prs = await this.request(query) as unknown as Json[];
      }
    }
    if (prs.length !== 1) throw new Error("Ambiguous publisher pull request");
    return this.validatePr(prs[0], repo, branch, base, sha);
  }
  private validatePr(pr: Json, repo: string, branch: string, base: string, sha: string): Json {
    if (pr.head?.ref !== branch || pr.head?.sha !== sha || pr.head?.repo?.full_name !== repo.slice(7) || pr.base?.ref !== base || pr.base?.repo?.full_name !== repo.slice(7)) throw new Error("Pull request does not match publisher branch");
    return pr;
  }
  private async open(req: OpenPatchPrRequest | OpenRevertPrRequest, deleting: boolean, kind: "patch" | "metadata" | "message" = "patch"): Promise<OpenedPr> {
    let repo: string;
    if (kind !== "patch") {
      if (kind === "metadata") assertMetadataRequest(req as OpenMetadataPrRequest);
      else assertMessageRequest(req as OpenGeneralMessagePrRequest);
      if (!req.idempotencyKey) throw new Error("Missing idempotency key");
      repo = this.dataRepo(req.repo);
    } else repo = this.patch(req);
    const content = deleting ? undefined : (req as OpenPatchPrRequest).content;
    const message = this.marker(req.branch, await fingerprint([req.idempotencyKey, req.path, deleting ? null : content]));
    const base = await this.defaultRef(repo);
    if (req.branch === base.ref) throw new Error("Cannot write the default branch");
    const existing = await this.optional(`${repo}/git/ref/heads/${encode(req.branch)}`);
    let sha: string;
    if (existing) sha = requireSha(existing.object.sha);
    else {
      const file = await this.optional(`${repo}/contents/${req.path}?ref=${base.sha}`);
      if (deleting ? !file : !!file) throw new Error("Patch path conflicts with current data");
      sha = await this.makeCommit(repo, base.sha, { path: req.path, mode: "100644", type: "blob", ...(deleting ? { sha: null } : { content }) }, message);
      sha = await this.createRef(repo, req.branch, sha);
    }
    const commit = await this.verifyChange(repo, sha, req.path, message, content);
    const pr = await this.pull(repo, req.branch, base.ref, req.title, req.body, sha);
    return { prNumber: pr.number, url: pr.html_url, commitSha: sha, baseSha: commit.parents[0].sha };
  }
  openPatchPr(req: OpenPatchPrRequest): Promise<OpenedPr> { return this.open(req, false); }
  openMetadataPr(req: OpenMetadataPrRequest): Promise<OpenedPr> { return this.open(req, false, "metadata"); }
  getMetadataPullRequest(req: { repo: string; prNumber: number }): Promise<PullRequestState> { return this.readPullRequest(req, "metadata"); }
  openGeneralMessagePr(req: OpenGeneralMessagePrRequest): Promise<OpenedPr> { return this.open(req, false, "message"); }
  getGeneralMessagePullRequest(req: { repo: string; prNumber: number }): Promise<PullRequestState> { return this.readPullRequest(req, "message"); }
  openRevertPr(req: OpenRevertPrRequest): Promise<OpenedPr> { return this.open(req, true); }
  async getPullRequest(req: { repo: string; prNumber: number }): Promise<PullRequestState> {
    return this.readPullRequest(req, "patch");
  }
  private async readPullRequest(req: { repo: string; prNumber: number }, kind: "patch" | "metadata" | "message"): Promise<PullRequestState> {
    const repo = this.dataRepo(req.repo);
    const pr = await this.request(`${repo}/pulls/${this.prNumber(req.prNumber)}`);
    if (kind === "metadata") {
      if (!METADATA_BRANCH.test(pr.head.ref)) throw new Error("Unowned metadata branch");
    } else if (kind === "message") {
      if (!MESSAGE_BRANCH.test(pr.head.ref)) throw new Error("Unowned general message branch");
    } else assertPatchBranch(pr.head.ref);
    this.validatePr(pr, repo, pr.head.ref, (await this.defaultRef(repo)).ref, pr.head.sha);
    await this.verifyOwnedPatch(repo, pr.head.ref, pr.head.sha, kind);
    return { state: pr.state, merged: pr.merged === true, mergeSha: pr.merged ? requireSha(pr.merge_commit_sha) : null, baseRef: pr.base.ref };
  }
  private async verifyOwnedPatch(repo: string, branch: string, sha: string, kind: "patch" | "metadata" | "message" = "patch"): Promise<void> {
    const commit = await this.commit(repo, sha);
    const prefix = `ituob-publisher ${branch} `;
    if (!commit.message.startsWith(prefix) || !/^[A-Za-z0-9_-]{43}$/.test(commit.message.slice(prefix.length)) || commit.parents?.length !== 1) throw new Error("Unowned pull request");
    const diff = await this.request(`${repo}/compare/${requireSha(commit.parents[0].sha)}...${requireSha(sha)}`);
    const issue = kind === "metadata" ? /^rt-meta-([1-9]\d*)-r[1-9]\d*$/.exec(branch)?.[1] : null;
    const filename = diff.files?.[0]?.filename ?? "";
    let validPath = kind === "metadata" ? filename === `ob-issues/${issue}/meta.yaml` : actionPath.test(filename);
    if (kind === "message") {
      const match = /^rt-msg-([1-9]\d*)-([0-9A-Z]{26})-r([1-9]\d*)$/.exec(branch)!;
      const relative = filename.slice(`ob-issues/${match[1]}/`.length);
      const type = relative.startsWith("general/") ? relative.slice(8, -5) : relative.split("/")[0];
      try { assertMessageRequest({ edition: Number(match[1]), messageId: match[2], revision: Number(match[3]), messageType: type, branch, path: filename } as OpenGeneralMessagePrRequest); validPath = true; }
      catch { validPath = false; }
    }
    if (diff.files?.length !== 1 || diff.files[0].previous_filename || !validPath) throw new Error("Unowned patch changes");
  }
  private prNumber(value: number): number {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid PR number");
    return value;
  }
  async closePatchPr(req: { repo: string; branch: string; prNumber: number }): Promise<void> {
    const repo = this.dataRepo(req.repo);
    assertPatchBranch(req.branch);
    const pr = await this.request(`${repo}/pulls/${this.prNumber(req.prNumber)}`);
    const base = await this.defaultRef(repo);
    if (req.branch === base.ref) throw new Error("Cannot close the default branch");
    this.validatePr(pr, repo, req.branch, base.ref, pr.head.sha);
    await this.verifyOwnedPatch(repo, req.branch, pr.head.sha);
    if (pr.merged) throw new Error("Cannot close a merged pull request");
    await this.request(`${repo}/pulls/${req.prNumber}`, "PATCH", { state: "closed" });
    const ref = await this.optional(`${repo}/git/ref/heads/${encode(req.branch)}`);
    if (ref && ref.object.sha === pr.head.sha) await this.request(`${repo}/git/refs/heads/${encode(req.branch)}`, "DELETE");
  }

  async bumpDataPin(req: PinBumpRequest): Promise<PinBump> {
    const data = this.dataRepo(this.config.PATCH_REPO ?? "");
    const c = this.config;
    const staging = c.GITHUB_STAGING_BRANCH ?? "staging";
    if (!c.GITHUB_SITE_REPO || !repoPattern.test(c.GITHUB_SITE_REPO) || !["data", "data-ob"].includes(c.GITHUB_DATA_GITLINK ?? "") || !/^[a-zA-Z0-9_-]+$/.test(staging) || ["main", "master"].includes(staging)) throw new PublisherNotConfigured();
    if (!Number.isSafeInteger(req.edition) || req.edition < 1 || !req.idempotencyKey || !req.items.length || new Set(req.items.map(item => item.submissionId)).size !== req.items.length || req.items.some(item => !item.submissionId || !item.mergeSha || !shaPattern.test(item.mergeSha))) throw new Error("Invalid pin publication request");
    const repo = `/repos/${c.GITHUB_SITE_REPO}`;
    if ((await this.request(repo)).default_branch === staging) throw new Error("Staging must not be the default branch");
    const branch = `rt-publish-${req.edition}`;
    const hash = await fingerprint([req.idempotencyKey, req.items]);
    const message = this.marker(branch, hash);
    const prior = await this.request(`${repo}/pulls?state=all&head=${encode(`${c.GITHUB_SITE_REPO.split("/")[0]}:${branch}`)}&base=${encode(staging)}&per_page=100`) as unknown as Json[];
    if (prior.length > 1) throw new Error("Ambiguous publication pull request");
    const existing = await this.optional(`${repo}/git/ref/heads/${branch}`) ?? (prior.length ? { object: { sha: prior[0].head.sha } } : null);
    let freeze: string;
    let sha: string;
    if (existing) {
      sha = requireSha(existing.object.sha);
      const file = await this.request(`${repo}/contents/${c.GITHUB_DATA_GITLINK}?ref=${sha}`);
      freeze = requireSha(file.sha);
    } else {
      freeze = (await this.defaultRef(data)).sha;
      await this.verifyAncestry(data, req, freeze);
      const base = await this.request(`${repo}/git/ref/heads/${encode(staging)}`);
      const original = await this.request(`${repo}/contents/${c.GITHUB_DATA_GITLINK}?ref=${requireSha(base.object.sha)}`);
      if (!this.gitlinkMatches(original.submodule_git_url)) throw new Error("Configured data path is not the patch repository gitlink");
      sha = await this.makeCommit(repo, base.object.sha, { path: c.GITHUB_DATA_GITLINK, mode: "160000", type: "commit", sha: freeze }, message);
      sha = await this.createRef(repo, branch, sha);
      const winner = await this.request(`${repo}/contents/${c.GITHUB_DATA_GITLINK}?ref=${sha}`);
      freeze = requireSha(winner.sha);
    }
    await this.verifyAncestry(data, req, freeze);
    await this.verifyChange(repo, sha, c.GITHUB_DATA_GITLINK!, message, undefined, freeze);
    const pinBody = `Review frozen data pin for edition ${req.edition}.\n\n<!-- ituob-publication:${hash} -->`;
    const pr = await this.pull(repo, branch, staging, `Publish bulletin ${req.edition}`, pinBody, sha);
    if (pr.body !== pinBody) throw new Error("Publication request differs from original pin PR");
    const current = await this.request(`${repo}/pulls/${pr.number}`);
    this.validatePr(current, repo, branch, staging, sha);
    const pending = (reason: string): PinBump => ({ freezeSha: freeze, siteCommit: sha, pending: { prNumber: pr.number, url: pr.html_url, reason } });
    if (!current.merged) return pending(current.state === "closed" ? "Pin pull request was closed without merging" : "Pin pull request awaits merge");
    const merged = requireSha(current.merge_commit_sha);
    const staged = await this.request(`${repo}/contents/${c.GITHUB_DATA_GITLINK}?ref=${merged}`);
    if (staged.sha !== freeze) throw new Error("Merged pin differs from frozen data");
    const runs = await this.request(`${repo}/actions/runs?head_sha=${merged}&branch=${encode(staging)}&per_page=100`);
    const candidates = runs.workflow_runs?.filter((run: Json) => run.head_sha === merged && run.head_branch === staging && run.path === ".github/workflows/build-deploy.yml" && run.event === "push") ?? [];
    candidates.sort((a: Json, b: Json) => b.id - a.id);
    const run = candidates[0];
    if (!run || run.status !== "completed" || run.conclusion !== "success") return pending("Exact merge commit awaits successful staging deployment");
    const jobs = await this.request(`${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
    if (jobs.total_count > 100 || !jobs.jobs?.some((job: Json) => job.name === "deploy-cloudflare-staging" && job.status === "completed" && job.conclusion === "success")) return pending("Staging deployment job has not succeeded");
    return { freezeSha: freeze, siteCommit: merged };
  }
  private gitlinkMatches(url: unknown): boolean {
    return typeof url === "string" && [
      `https://github.com/${this.config.PATCH_REPO}`, `https://github.com/${this.config.PATCH_REPO}.git`,
      `git@github.com:${this.config.PATCH_REPO}.git`,
    ].includes(url);
  }
  private async verifyAncestry(repo: string, req: PinBumpRequest, freeze: string): Promise<void> {
    for (const item of req.items) {
      const compare = await this.request(`${repo}/compare/${requireSha(item.mergeSha!)}...${freeze}`);
      if (!["ahead", "identical"].includes(compare.status)) throw new Error("Frozen data does not contain every supplied merge commit");
    }
  }
}
