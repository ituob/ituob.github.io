import { beforeAll, describe, expect, it } from "vitest";
import { GitHubAppPatchPublisher } from "../worker/lib/publisher";
import type { PublisherConfig } from "../worker/lib/publisher";

// Fake GitHub transport only: nothing here can reach a real repository.
const FREEZE = "b".repeat(40), STAGING = "c".repeat(40), MERGED = "d".repeat(40);
const req = { edition: 1300, freezeSha: FREEZE, idempotencyKey: "edition-1300-promote" };
let config: PublisherConfig;
beforeAll(async () => {
  const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey));
  config = { GITHUB_APP_ID: "123", GITHUB_APP_INSTALLATION_ID: "456", GITHUB_APP_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${Buffer.from(raw).toString("base64")}\n-----END PRIVATE KEY-----`, PATCH_REPO: "org/data", GITHUB_SITE_REPO: "org/site", GITHUB_DATA_GITLINK: "data-ob", GITHUB_STAGING_BRANCH: "staging" } as PublisherConfig;
});

class Site {
  calls: { path: string; method: string; body: any }[] = [];
  prs: any[] = [];
  stagingGitlink = FREEZE;
  merged = false;
  runStatus: string | null = null;
  jobName = "deploy-cloudflare-production";
  jobConclusion = "success";
  transport = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url), p = u.pathname, method = init.method!;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ path: p + u.search, method, body });
    const ok = (d: any, s = 200) => new Response(JSON.stringify(d), { status: s });
    if (p.startsWith("/app/installations/")) return ok({ token: "t", expires_at: new Date(Date.now() + 3600000).toISOString() });
    const s = p.replace("/repos/org/site", "");
    if (s === "") return ok({ default_branch: "main" });
    if (s === "/git/ref/heads/staging") return ok({ object: { sha: STAGING } });
    if (s === "/contents/data-ob") {
      const ref = u.searchParams.get("ref");
      return ok({ sha: ref === STAGING || ref === MERGED ? this.stagingGitlink : "a".repeat(40), submodule_git_url: "https://github.com/org/data.git" });
    }
    if (s === "/pulls" && method === "GET") return ok(this.prs);
    if (s === "/pulls" && method === "POST") {
      const pr = { number: 9, html_url: "https://github.com/org/site/pull/9", state: "open", body: body.body, head: { ref: body.head, sha: STAGING, repo: { full_name: "org/site" } }, base: { ref: body.base, repo: { full_name: "org/site" } } };
      this.prs.push(pr); return ok(pr, 201);
    }
    if (s === "/pulls/9") return ok({ ...this.prs[0], merged: this.merged, merge_commit_sha: MERGED });
    if (s === "/actions/runs") return ok({ workflow_runs: this.runStatus ? [{ id: 5, head_sha: MERGED, head_branch: "main", path: ".github/workflows/build-deploy.yml", event: "push", status: this.runStatus, conclusion: this.runStatus === "completed" ? "success" : null }] : [] });
    if (s === "/actions/runs/5/jobs") return ok({ total_count: 1, jobs: [{ name: this.jobName, status: "completed", conclusion: this.jobConclusion }] });
    throw new Error(`Unhandled ${method} ${s}`);
  };
  client() { return new GitHubAppPatchPublisher(config, this.transport); }
}

describe("production promotion (fake GitHub transport)", () => {
  it("opens one staging->main PR, never merges, and stays pending until the production job succeeds", async () => {
    const api = new Site(), client = api.client();
    expect((await client.promoteToProduction(req)).pending?.reason).toContain("awaits merge");
    expect((await client.promoteToProduction(req)).pending?.prNumber).toBe(9);
    expect(api.prs).toHaveLength(1);
    expect(api.calls.find((c) => c.method === "POST" && c.path === "/repos/org/site/pulls")!.body).toMatchObject({ head: "staging", base: "main" });
    api.merged = true;
    expect((await client.promoteToProduction(req)).pending?.reason).toContain("production deployment");
    api.runStatus = "in_progress";
    expect((await client.promoteToProduction(req)).pending).toBeDefined();
    api.runStatus = "completed"; api.jobName = "deploy-cloudflare-staging";
    expect((await client.promoteToProduction(req)).pending).toBeDefined();
    api.jobName = "deploy-cloudflare-production"; api.jobConclusion = "failure";
    expect((await client.promoteToProduction(req)).pending).toBeDefined();
    api.jobConclusion = "success";
    expect(await client.promoteToProduction(req)).toEqual({ siteCommit: MERGED });
    // The only writes ever made: the single PR creation. No merge, ref, tree, commit or PATCH call.
    expect(api.calls.filter((c) => c.method !== "GET" && !c.path.startsWith("/app/")).map((c) => `${c.method} ${c.path}`)).toEqual(["POST /repos/org/site/pulls"]);
  });

  it("refuses a staging branch that no longer pins the frozen data, and a staging branch equal to the default", async () => {
    const api = new Site();
    api.stagingGitlink = "e".repeat(40);
    await expect(api.client().promoteToProduction(req)).rejects.toThrow("frozen data");
    expect(api.calls.filter((c) => c.method !== "GET" && !c.path.startsWith("/app/"))).toEqual([]);
    for (const bad of [{ GITHUB_STAGING_BRANCH: "main" }, { GITHUB_SITE_REPO: undefined }])
      await expect(new GitHubAppPatchPublisher({ ...config, ...bad } as PublisherConfig, new Site().transport).promoteToProduction(req)).rejects.toThrow();
    await expect(api.client().promoteToProduction({ ...req, freezeSha: "nope" })).rejects.toThrow();
  });
});
