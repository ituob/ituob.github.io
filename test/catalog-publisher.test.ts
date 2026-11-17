import { beforeAll, describe, expect, it } from "vitest";
import { GitHubAppPatchPublisher } from "../worker/lib/github-publisher.ts";
import type { PublisherConfig } from "../worker/lib/publisher.ts";

const A = "a".repeat(40), BLOB = "b".repeat(40), NEW = "c".repeat(40), TREE = "d".repeat(40);
const REPO = "ituob/service-publications-docs";
const branch = "rt-cat-0123456789ab";
const path = "catalogs/registers.yaml";
const original = "registers:\n  - register_id: DP\n";
const content = `${original}  - register_id: NEW # café\n`;
let config: PublisherConfig;
beforeAll(async () => {
  const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey));
  config = { GITHUB_APP_ID: "123", GITHUB_APP_INSTALLATION_ID: "456", GITHUB_APP_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...raw))}\n-----END PRIVATE KEY-----`, PATCH_REPO: "org/data" };
});

const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
/** A catalog repository: default branch main at A holding `original`; immutable objects, new refs and PRs only. */
function github(opts: { blob?: string; files?: Record<string, string> } = {}) {
  const calls: { method: string; path: string; body?: any }[] = [];
  const refs = new Map<string, string>(); let commit: any = null; let tree: any = null; let pr: any = null;
  const files: Record<string, string> = { [path]: original, "catalogs/recommendations.yaml": "recommendations:\n", ...opts.files };
  const transport = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url), p = u.pathname, method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: p + u.search, body });
    const ok = (data: any, status = 200) => new Response(JSON.stringify(data), { status });
    if (p.startsWith("/app/")) return ok({ token: "t", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    const s = p.replace(`/repos/${REPO}`, "");
    if (!p.startsWith(`/repos/${REPO}`)) return ok({}, 404);
    if (s === "") return ok({ default_branch: "main" });
    if (s === "/git/ref/heads/main") return ok({ object: { sha: A } });
    if (s.startsWith("/git/ref/heads/")) { const n = decodeURIComponent(s.slice(15)); return refs.has(n) ? ok({ object: { sha: refs.get(n) } }) : ok({}, 404); }
    if (s.startsWith("/contents/")) {
      const name = s.slice(10), ref = u.searchParams.get("ref");
      const text = ref === NEW ? commit?.content : files[name];
      return text === undefined ? ok({}, 404) : ok({ encoding: "base64", content: b64(text), sha: ref === NEW ? "e".repeat(40) : (name === path ? (opts.blob ?? BLOB) : "f".repeat(40)) });
    }
    if (s === `/git/commits/${A}`) return ok({ sha: A, tree: { sha: TREE }, parents: [], message: "base" });
    if (s === "/git/trees") { tree = body; return ok({ sha: TREE }); }
    if (s === "/git/commits") { commit = { ...body, content: tree.tree[0].content, sha: NEW, parents: body.parents.map((sha: string) => ({ sha })) }; return ok({ sha: NEW }); }
    if (s === `/git/commits/${NEW}`) return ok(commit);
    if (s === "/git/refs") { refs.set(body.ref.replace("refs/heads/", ""), body.sha); return ok({}, 201); }
    if (s.startsWith("/compare/")) return ok({ files: [{ filename: tree.tree[0].path, status: "modified" }] });
    if (s === "/pulls" && method === "GET") return ok(pr ? [pr] : []);
    if (s === "/pulls") { pr = { state: "open", merged_at: null, number: 7, html_url: `https://github.com/${REPO}/pull/7`, head: { ref: body.head, sha: NEW, repo: { full_name: REPO } }, base: { ref: "main", repo: { full_name: REPO } } }; return ok(pr, 201); }
    return ok({}, 404);
  };
  return { calls, transport, refs, get tree() { return tree; }, closePr() { pr.state = "closed"; pr.merged_at = null; } };
}
const req = { repo: REPO, branch, path, content, baseBlobSha: BLOB, title: "Add NEW", body: "Review", idempotencyKey: branch };

describe("catalog publisher", () => {
  it("reads both catalog files at the default branch head", async () => {
    const gh = github();
    const snap = await new GitHubAppPatchPublisher(config, gh.transport).readCatalog({ repo: REPO });
    expect(snap).toMatchObject({ baseSha: A, registers: { text: original, blobSha: BLOB }, recommendations: { text: "recommendations:\n" } });
    expect(gh.calls.every((c) => c.method === "GET" || c.path.startsWith("/app/"))).toBe(true);
  });

  it("commits exactly one file on a new rt-cat branch and opens a PR, never writing the default branch", async () => {
    const gh = github();
    const pr = await new GitHubAppPatchPublisher(config, gh.transport).openCatalogPr(req);
    expect(pr).toMatchObject({ prNumber: 7, commitSha: NEW });
    expect(gh.tree.tree).toEqual([{ path, mode: "100644", type: "blob", content }]);
    expect([...gh.refs.keys()]).toEqual([branch]);
    expect(gh.calls.filter((c) => c.method !== "GET" && !c.path.startsWith("/app/")).map((c) => c.path.replace(`/repos/${REPO}`, ""))).toEqual(["/git/trees", "/git/commits", "/git/refs", "/pulls"]);
  });

  it("rejects a no-change edit before creating any GitHub objects or refs", async () => {
    const gh = github();
    const publisher = new GitHubAppPatchPublisher(config, gh.transport);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(publisher.openCatalogPr({ ...req, content: original })).rejects.toThrow("no change");
    }
    expect(gh.refs.size).toBe(0);
    expect(gh.calls.filter((c) => c.method !== "GET" && !c.path.startsWith("/app/"))).toEqual([]);
  });

  it("refuses a closed unmerged catalog PR on retry with a clear error", async () => {
    const gh = github();
    const publisher = new GitHubAppPatchPublisher(config, gh.transport);
    const first = await publisher.openCatalogPr(req);
    expect(await publisher.openCatalogPr(req)).toEqual(first);
    gh.closePr();
    const writes = gh.calls.filter((c) => c.method === "POST").length;
    await expect(publisher.openCatalogPr(req)).rejects.toThrow("closed without merging");
    expect(gh.calls.filter((c) => c.method === "POST")).toHaveLength(writes);
    expect([...gh.refs.keys()]).toEqual([branch]);
  });

  it("refuses a moved catalog file, another repository, another path and a non-catalog branch before writing", async () => {
    const moved = github({ blob: "9".repeat(40) });
    await expect(new GitHubAppPatchPublisher(config, moved.transport).openCatalogPr(req)).rejects.toThrow("Catalog changed since it was read");
    expect(moved.calls.some((c) => c.method === "POST" && !c.path.startsWith("/app/"))).toBe(false);
    const gh = github();
    const publisher = new GitHubAppPatchPublisher(config, gh.transport);
    await expect(publisher.openCatalogPr({ ...req, repo: "org/data" })).rejects.toThrow();
    await expect(publisher.openCatalogPr({ ...req, path: "catalogs/recommendations.yaml" })).rejects.toThrow("Invalid catalog destination");
    await expect(publisher.openCatalogPr({ ...req, branch: "main" })).rejects.toThrow("Invalid catalog destination");
    await expect(publisher.openCatalogPr({ ...req, branch: "rt-sub-1300-001-test-ABCDEFGH" })).rejects.toThrow("Invalid catalog destination");
    await expect(publisher.readCatalog({ repo: "org/data" })).rejects.toThrow();
    expect(gh.calls.length).toBe(0);
  });
});
