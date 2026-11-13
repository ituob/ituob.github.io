import { beforeAll, describe, expect, it, vi } from "vitest";
import { GitHubAppPatchPublisher, getPublisher, PublisherNotConfigured, setPublisher, FakePatchPublisher } from "../worker/lib/publisher";
import type { PublisherConfig } from "../worker/lib/publisher";

const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40), D = "d".repeat(40);
const branch = "rt-sub-1300-001-test-ABCDEFGH";
const path = "ob-issues/1300/test/001-ADD.yaml";
const req = { repo: "org/data", branch, path, content: "type: ADD\n# café\n", title: "Patch", body: "Review", idempotencyKey: "submission-1" };
let config: PublisherConfig;
let publicKey: CryptoKey;
beforeAll(async () => {
  const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  publicKey = keys.publicKey;
  const raw = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey));
  config = { GITHUB_APP_ID: "123", GITHUB_APP_INSTALLATION_ID: "456", GITHUB_APP_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${Buffer.from(raw).toString("base64")}\n-----END PRIVATE KEY-----`, PATCH_REPO: "org/data", GITHUB_SITE_REPO: "org/site", GITHUB_DATA_GITLINK: "data-ob" };
});

/** Stateful HTTP boundary: real JWT signing, immutable Git objects and ref races. */
class GitHub {
  calls: { path: string; method: string; body: any }[] = [];
  commits = new Map<string, any>([[A, { sha: A, tree: { sha: A }, parents: [], message: "base" }]]);
  refs = new Map<string, string>();
  prs: any[] = [];
  entries = new Map<string, any>();
  parentFiles = false;
  racing = false;
  differentRace = false;
  merged = false;
  run: string | null = null;
  job = "success";
  runSha = D;
  failPrRace = false;
  freeze = B;
  compareStatus = "ahead";
  transport = async (url: string, init: RequestInit): Promise<Response> => {
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const u = new URL(url), p = u.pathname, method = init.method!;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ path: p + u.search, method, body });
    const respond = (data: any, status = 200) => new Response(status === 204 ? null : JSON.stringify(data), { status });
    if (p.startsWith("/app/installations/")) {
      const jwt = (init.headers as any).Authorization.slice(7);
      const [head, payload, sig] = jwt.split(".");
      expect(JSON.parse(Buffer.from(head, "base64url").toString()).alg).toBe("RS256");
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
      expect(claims.iss).toBe("123"); expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
      expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, Buffer.from(sig, "base64url"), new TextEncoder().encode(`${head}.${payload}`))).toBe(true);
      return respond({ token: "secret-installation-token", expires_at: new Date(Date.now() + 3600000).toISOString() });
    }
    expect((init.headers as any).Authorization).toBe("Bearer secret-installation-token");
    const site = p.startsWith("/repos/org/site"), repo = site ? "org/site" : "org/data";
    const suffix = p.replace(`/repos/${repo}`, "");
    if (!suffix) return respond({ default_branch: "main" });
    if (suffix.startsWith("/git/ref/heads/")) {
      const name = decodeURIComponent(suffix.slice(15));
      if (name === "main") return respond({ object: { sha: site ? A : this.freeze } });
      if (name === "staging") return respond({ object: { sha: A } });
      return this.refs.has(name) ? respond({ object: { sha: this.refs.get(name) } }) : respond({}, 404);
    }
    if (suffix === "/git/trees") { this.entries.set(C, body.tree[0]); return respond({ sha: C }); }
    if (suffix === "/git/commits") {
      const commit = { ...body, sha: C, tree: { sha: C }, parents: body.parents.map((sha: string) => ({ sha })) };
      this.commits.set(C, commit); return respond({ sha: C });
    }
    if (suffix.startsWith("/git/commits/")) return respond(this.commits.get(suffix.split("/").at(-1)!) ?? { sha: B, tree: { sha: B }, parents: [], message: "data" });
    if (suffix === "/git/refs") {
      const name = body.ref.replace("refs/heads/", ""); this.refs.set(name, this.differentRace ? D : body.sha);
      return respond({}, this.racing || this.differentRace ? 422 : 201);
    }
    if (suffix.startsWith("/git/refs/")) { this.refs.delete(decodeURIComponent(suffix.slice(16))); return respond(null, 204); }
    if (suffix.startsWith("/compare/")) {
      if (site || suffix.endsWith(`...${C}`)) return respond({ files: [{ filename: site ? "data-ob" : path, status: this.entries.get(C)?.sha === null ? "removed" : "added" }] });
      return respond({ status: this.compareStatus });
    }
    if (suffix.startsWith("/contents/")) {
      const ref = u.searchParams.get("ref");
      if (site) return respond({ sha: ref === A ? A : this.entries.get(C)?.sha ?? B, submodule_git_url: "https://github.com/org/data.git" });
      if (ref !== C) return this.parentFiles ? respond({ sha: B }) : respond({}, 404);
      return respond({ encoding: "base64", content: Buffer.from(this.entries.get(C).content).toString("base64") });
    }
    if (suffix === "/pulls" && method === "GET") return respond(this.prs);
    if (suffix === "/pulls" && method === "POST") {
      const pr = { number: 1, html_url: `https://github.com/${repo}/pull/1`, head: { ref: body.head, sha: this.refs.get(body.head), repo: { full_name: repo } }, base: { ref: body.base, repo: { full_name: repo } }, body: body.body, state: "open", merged: false };
      this.prs.push(pr); return this.failPrRace ? respond({}, 422) : respond(pr, 201);
    }
    if (suffix === "/pulls/1") {
      if (method === "PATCH") this.prs[0].state = body.state;
      return respond({ ...this.prs[0], merged: this.merged, merge_commit_sha: D });
    }
    if (suffix === "/actions/runs") return respond({ workflow_runs: this.run ? [{ id: 22, head_sha: this.runSha, head_branch: "staging", path: ".github/workflows/build-deploy.yml", event: "push", status: this.run === "pending" ? "in_progress" : "completed", conclusion: this.run }] : [] });
    if (suffix === "/actions/runs/22/jobs") return respond({ total_count: 1, jobs: [{ name: "deploy-cloudflare-staging", status: "completed", conclusion: this.job }] });
    throw new Error(`Unhandled ${method} ${suffix}`);
  };
  client() { return new GitHubAppPatchPublisher(config, this.transport); }
}

describe("GitHub App publisher", () => {
  it("fails closed without configuration and preserves fake override", async () => {
    await expect(new GitHubAppPatchPublisher().openPatchPr(req)).rejects.toBeInstanceOf(PublisherNotConfigured);
    const fake = new FakePatchPublisher(); setPublisher(fake); expect(getPublisher(config)).toBe(fake); setPublisher(null);
  });
  it("signs a real App JWT, preserves bytes and reuses immutable branch/PR", async () => {
    const api = new GitHub(), client = api.client();
    const first = await client.openPatchPr(req);
    expect(await client.openPatchPr(req)).toEqual(first);
    expect(api.entries.get(C).content).toBe(req.content);
    expect(api.calls.filter(c => c.path === "/app/installations/456/access_tokens")).toHaveLength(1);
    expect(api.calls.filter(c => c.path === "/repos/org/data/git/refs")).toHaveLength(1);
    expect(api.prs).toHaveLength(1);
    expect(api.calls.filter(c => c.method === "PATCH")).toHaveLength(0);
  });
  it("rejects invalid repo, protected refs and non-action paths before network", async () => {
    const api = new GitHub();
    for (const bad of [{ repo: "other/data" }, { branch: "main" }, { path: "ob-issues/1300/test/../state.yaml" }, { path: "registers/test.yaml" }, { path: "ob-issues/1300/test/001-state.yaml" }]) await expect(api.client().openPatchPr({ ...req, ...bad })).rejects.toThrow();
    expect(api.calls).toHaveLength(0);
  });
  it("reuses a matching concurrent ref and rejects unrelated race winners", async () => {
    const api = new GitHub(); api.racing = true; api.failPrRace = true;
    expect((await api.client().openPatchPr(req)).commitSha).toBe(C);
    const unrelated = new GitHub(); unrelated.differentRace = true;
    await expect(unrelated.client().openPatchPr(req)).rejects.toThrow("Existing branch");
    expect(unrelated.prs).toHaveLength(0);
  });
  it("rejects altered content on retry without overwriting a branch", async () => {
    const api = new GitHub(), client = api.client(); await client.openPatchPr(req);
    await expect(client.openPatchPr({ ...req, content: "changed" })).rejects.toThrow("Existing branch");
    api.entries.get(C).content = "tampered";
    await expect(client.openPatchPr(req)).rejects.toThrow("bytes differ");
    expect(api.calls.filter(c => c.method === "PATCH")).toHaveLength(0);
  });
  it("reverts only the action via a PR", async () => {
    const api = new GitHub(); api.parentFiles = true;
    await api.client().openRevertPr(req);
    expect(api.entries.get(C)).toEqual({ path, mode: "100644", type: "blob", sha: null });
    expect(api.prs[0].base.ref).toBe("main");
    expect(api.calls.some(c => c.path.includes("/merges"))).toBe(false);
  });
  it("closes only the matching owned PR and branch", async () => {
    const api = new GitHub(), client = api.client(); await client.openPatchPr(req);
    await expect(client.closePatchPr({ ...req, branch: "rt-sub-1300-002-other-ABCDEFGH", prNumber: 1 })).rejects.toThrow("does not match");
    await client.closePatchPr({ ...req, prNumber: 1 });
    expect(api.prs[0].state).toBe("closed");
    expect(api.calls.filter(c => c.method === "DELETE").map(c => c.path)).toEqual([`/repos/org/data/git/refs/heads/${branch}`]);
  });
  it("reads only owned PR state and rejects unrelated branch changes", async () => {
    const api = new GitHub(), client = api.client(); await client.openPatchPr(req);
    expect(await client.getPullRequest({ repo: req.repo, prNumber: 1 })).toEqual({ state: "open", merged: false, mergeSha: null, baseRef: "main" });
    api.merged = true;
    expect((await client.getPullRequest({ repo: req.repo, prNumber: 1 })).mergeSha).toBe(D);
    api.commits.get(C).message = "unrelated";
    await expect(client.getPullRequest({ repo: req.repo, prNumber: 1 })).rejects.toThrow("Unowned");
  });
  it("aborts stalled transport at the bounded deadline", async () => {
    vi.useFakeTimers();
    try {
      let started!: () => void;
      const barrier = new Promise<void>(resolve => { started = resolve; });
      const client = new GitHubAppPatchPublisher(config, async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(new Error("transport aborted")));
        started();
      }));
      const assertion = expect(client.openPatchPr(req)).rejects.toThrow("GitHub publisher request failed (0)");
      await barrier;
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
    } finally { vi.useRealTimers(); }
  });
  it("sanitizes HTTP, transport and invalid key failures", async () => {
    for (const transport of [async () => new Response("private secret", { status: 403 }), async () => { throw new Error("secret-installation-token"); }]) {
      await expect(new GitHubAppPatchPublisher(config, transport).openPatchPr(req)).rejects.toThrow(/^GitHub publisher request failed/);
    }
    await expect(new GitHubAppPatchPublisher({ ...config, GITHUB_APP_PRIVATE_KEY: "secret" }).openPatchPr(req)).rejects.toThrow("GitHub App authentication failed");
  });
});

const pin = { edition: 1300, idempotencyKey: "edition-1300", items: [{ submissionId: "submission-1", mergeSha: B }] };
describe("staging pin publication", () => {
  it("remains pending until merged and exact staging deployment succeeds", async () => {
    const api = new GitHub(), client = api.client();
    expect((await client.bumpDataPin(pin)).pending?.reason).toContain("awaits merge");
    api.merged = true;
    for (const state of [null, "pending", "failure", "success"]) {
      api.run = state; api.job = "skipped";
      expect((await client.bumpDataPin(pin)).pending).toBeDefined();
    }
    api.job = "failure";
    expect((await client.bumpDataPin(pin)).pending).toBeDefined();
    api.job = "success"; api.runSha = A;
    expect((await client.bumpDataPin(pin)).pending).toBeDefined();
    api.runSha = D;
    expect(await client.bumpDataPin(pin)).toEqual({ freezeSha: B, siteCommit: D });
    expect(api.calls.filter(c => c.method === "PATCH")).toHaveLength(0);
  });
  it("freezes the original data pin and recovers a merged PR after branch deletion", async () => {
    const api = new GitHub(), client = api.client(); await client.bumpDataPin(pin);
    api.freeze = D; api.refs.clear(); api.merged = true; api.run = "success";
    expect(await client.bumpDataPin(pin)).toEqual({ freezeSha: B, siteCommit: D });
    expect(api.calls.filter(c => c.path === "/repos/org/site/git/refs")).toHaveLength(1);
  });
  it("requires explicit gitlink and refuses a protected staging target", async () => {
    for (const bad of [{ GITHUB_DATA_GITLINK: undefined }, { GITHUB_STAGING_BRANCH: "main" }]) {
      const api = new GitHub();
      await expect(new GitHubAppPatchPublisher({ ...config, ...bad }, api.transport).bumpDataPin(pin)).rejects.toBeInstanceOf(PublisherNotConfigured);
      expect(api.calls).toHaveLength(0);
    }
  });
  it("refuses changed placement and commits absent from frozen data", async () => {
    const api = new GitHub(), client = api.client(); await client.bumpDataPin(pin);
    api.merged = true; api.run = "success";
    await expect(client.bumpDataPin({ ...pin, items: [{ submissionId: "different", mergeSha: B }] })).rejects.toThrow("Existing branch");
    await expect(client.bumpDataPin({ ...pin, items: [...pin.items, { submissionId: "submission-2", mergeSha: B }] })).rejects.toThrow("Existing branch");
    api.prs[0].body = "modified publication";
    await expect(client.bumpDataPin(pin)).rejects.toThrow("differs from original pin PR");
    api.compareStatus = "diverged";
    await expect(client.bumpDataPin(pin)).rejects.toThrow("does not contain every");
  });
});
