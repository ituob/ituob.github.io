// End-to-end acceptance demo for ituob/ituob.github.io#103 (submission workflow).
//
// One run drives the whole Worker through its real HTTP entry point (worker.fetch), against a real
// local D1 with the real migrations, in workerd:
//
//   mock OIDC sign-in -> member claim + staff verification -> member proposes a real E.164 register
//   patch (stage2 warnings) -> staff review -> approve (patch PR on itu-ob-data) -> human merge ->
//   compose -> Stage (pin PR into staging) -> human merge + staging deploy -> Publish (staging -> main
//   PR) -> human merge + production deploy -> published; plus the notification outbox and recorded mail.
//
// Boundaries that are faked, and nothing else: the OpenID provider (test/mock-idp.ts), Cloudflare
// Access signing keys, and the GitHub REST API. The Worker's own GitHubAppPatchPublisher makes real
// signed requests; `FakeGitHub` below answers them from an in-memory git model. Any other outbound
// host makes the test fail. No network, no Cloudflare, no email is used.
//
// The transcript is a build artifact: it is compared with, and (with `-u`) regenerated into,
// docs/acceptance/103-end-to-end-demo.transcript.txt.
import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import worker from "../worker/index.ts";
import { verifyChain } from "../worker/lib/audit.ts";
import { clearAccessKeyCache, verifyAccessIdentity } from "../worker/lib/access.ts";
import { setEmailSender } from "../worker/lib/email.ts";
import { provisionItuStaff } from "../worker/lib/membership.ts";
import { resetOidcCaches } from "../worker/lib/oidc.ts";
import { setPublisher } from "../worker/lib/publisher.ts";
import type { NotifyMessage } from "../worker/lib/outbox.ts";
import { db } from "./helpers.ts";
import { CLIENT_ID, CLIENT_SECRET, ISSUER, MockIdp } from "./mock-idp.ts";

const TRANSCRIPT_FILE = "../docs/acceptance/103-end-to-end-demo.transcript.txt";
const dataFiles = import.meta.glob("../data-ob/datasets/1114-E.164D/data.yaml", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const E164_ROWS = parseYaml(Object.values(dataFiles)[0]!) as Array<Record<string, any>>;

const DATA_REPO = "ituob/itu-ob-data";
const SITE_REPO = "ituob/ituob.github.io";
const ACCESS_DOMAIN = "https://ituob-demo.cloudflareaccess.com";
const ACCESS_AUD = "demo-application-audience";
const EDITION = 1351;

// ---------------------------------------------------------------------------------------------
// Fake GitHub: an in-memory git model behind the REST endpoints the publisher uses.
// ---------------------------------------------------------------------------------------------
interface Entry { mode: string; type: string; content?: string; sha?: string }
type Tree = Record<string, Entry>;
interface Commit { sha: string; message: string; parents: string[]; tree: string }
interface Pull { number: number; state: "open" | "closed"; merged: boolean; merge_commit_sha: string | null; title: string; body: string; html_url: string; head: { ref: string; sha: string; repo: { full_name: string } }; base: { ref: string; repo: { full_name: string } } }
interface Run { id: number; head_sha: string; head_branch: string; path: string; event: string; status: string; conclusion: string | null; jobs: { name: string; status: string; conclusion: string }[] }

class Repo {
  commits = new Map<string, Commit>();
  trees = new Map<string, Tree>();
  refs = new Map<string, string>();
  pulls: Pull[] = [];
  runs: Run[] = [];
  constructor(readonly name: string, readonly defaultBranch = "main") {}
}

class FakeGitHub {
  repos = new Map<string, Repo>();
  /** Every request the Worker made, in order. */
  log: { method: string; path: string; body: any }[] = [];
  private n = 0;
  private runId = 100;
  constructor(readonly publicKey: CryptoKey) {
    const data = this.add(DATA_REPO);
    const site = this.add(SITE_REPO);
    const d0 = this.seedCommit(data, "initial data", {});
    data.refs.set("main", d0);
    const s0 = this.seedCommit(site, "initial site", { data: { mode: "160000", type: "commit", sha: d0 } });
    site.refs.set("main", s0);
    site.refs.set("staging", s0);
  }
  private add(name: string) { const r = new Repo(name); this.repos.set(name, r); return r; }
  nextSha() { return (++this.n).toString(16).padStart(8, "0").repeat(5); }
  private seedCommit(repo: Repo, message: string, tree: Tree): string {
    const treeSha = this.nextSha(), sha = this.nextSha();
    repo.trees.set(treeSha, tree);
    repo.commits.set(sha, { sha, message, parents: [], tree: treeSha });
    return sha;
  }
  repo(name: string) { const r = this.repos.get(name); if (!r) throw new Error(`unknown repo ${name}`); return r; }
  treeOf(repo: Repo, sha: string): Tree { return repo.trees.get(repo.commits.get(sha)!.tree)!; }
  private resolve(repo: Repo, ref: string | null): string | null {
    if (!ref) return null;
    if (repo.commits.has(ref)) return ref;
    return repo.refs.get(ref) ?? null;
  }
  private ancestors(repo: Repo, sha: string): Set<string> {
    const seen = new Set<string>(), stack = [sha];
    while (stack.length) { const s = stack.pop()!; if (seen.has(s)) continue; seen.add(s); stack.push(...repo.commits.get(s)!.parents); }
    return seen;
  }
  private diff(a: Tree, b: Tree) {
    const files: { filename: string; status: string }[] = [];
    for (const k of Object.keys(b)) if (!a[k]) files.push({ filename: k, status: "added" }); else if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) files.push({ filename: k, status: "modified" });
    for (const k of Object.keys(a)) if (!b[k]) files.push({ filename: k, status: "removed" });
    return files;
  }

  /** The human clicks "Merge" on a PR. Branch protection and checks are the repository's business. */
  humanMerge(repoName: string, number: number): string {
    const repo = this.repo(repoName), pr = repo.pulls.find(p => p.number === number)!;
    expect(pr.state, "PR must be open to be merged").toBe("open");
    const baseTip = repo.refs.get(pr.base.ref)!;
    const baseTree = this.treeOf(repo, baseTip), headTree = this.treeOf(repo, pr.head.sha);
    const merged: Tree = { ...baseTree };
    for (const [k, v] of Object.entries(headTree)) if (JSON.stringify(baseTree[k]) !== JSON.stringify(v)) merged[k] = v;
    const treeSha = this.nextSha(), sha = this.nextSha();
    repo.trees.set(treeSha, merged);
    repo.commits.set(sha, { sha, message: `Merge pull request #${number}`, parents: [baseTip, pr.head.sha], tree: treeSha });
    repo.refs.set(pr.base.ref, sha);
    pr.state = "closed"; pr.merged = true; pr.merge_commit_sha = sha;
    return sha;
  }
  /** GitHub Actions finished a deployment job for a pushed commit. */
  deploy(repoName: string, branch: string, sha: string, job: string, conclusion: "success" | "failure") {
    this.repo(repoName).runs.push({ id: ++this.runId, head_sha: sha, head_branch: branch, path: ".github/workflows/build-deploy.yml", event: "push", status: "completed", conclusion, jobs: [{ name: job, status: "completed", conclusion }] });
  }

  transport = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url), p = u.pathname, method = (init.method ?? "GET").toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const respond = (data: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(data), { status });
    const auth = String((init.headers as Record<string, string>)?.Authorization ?? "").replace(/^Bearer /, "");
    if (p.startsWith("/app/installations/")) {
      const [h, pl, sig] = auth.split(".");
      const claims = JSON.parse(atob(pl!.replace(/-/g, "+").replace(/_/g, "/")));
      const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", this.publicKey, Uint8Array.from(atob(sig!.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0)), new TextEncoder().encode(`${h}.${pl}`));
      if (!ok || claims.iss !== "424242") return respond({ message: "Bad credentials" }, 401);
      this.log.push({ method, path: p, body });
      return respond({ token: "installation-token-not-real", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    if (auth !== "installation-token-not-real") return respond({ message: "Bad credentials" }, 401);
    const m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(p);
    if (!m) return respond({}, 404);
    const repo = this.repos.get(m[1]!);
    if (!repo) return respond({}, 404);
    const rest = m[2] ?? "";
    this.log.push({ method, path: p + u.search, body });
    if (rest === "") return respond({ default_branch: repo.defaultBranch });
    let g: RegExpExecArray | null;
    if ((g = /^\/git\/ref\/heads\/(.+)$/.exec(rest))) { const sha = repo.refs.get(decodeURIComponent(g[1]!)); return sha ? respond({ object: { sha } }) : respond({}, 404); }
    if (rest === "/git/trees" && method === "POST") {
      const base = { ...repo.trees.get(body.base_tree)! };
      for (const e of body.tree) {
        if (e.sha === null) delete base[e.path];
        else if (e.mode === "160000") base[e.path] = { mode: e.mode, type: "commit", sha: e.sha };
        else base[e.path] = { mode: e.mode, type: "blob", content: e.content, sha: this.nextSha() };
      }
      const sha = this.nextSha(); repo.trees.set(sha, base); return respond({ sha });
    }
    if (rest === "/git/commits" && method === "POST") {
      const sha = this.nextSha();
      repo.commits.set(sha, { sha, message: body.message, parents: body.parents, tree: body.tree });
      return respond({ sha });
    }
    if ((g = /^\/git\/commits\/([0-9a-f]{40})$/.exec(rest))) {
      const c = repo.commits.get(g[1]!);
      return c ? respond({ sha: c.sha, message: c.message, tree: { sha: c.tree }, parents: c.parents.map(sha => ({ sha })) }) : respond({}, 404);
    }
    if (rest === "/git/refs" && method === "POST") {
      const name = String(body.ref).replace("refs/heads/", "");
      if (repo.refs.has(name)) return respond({ message: "Reference already exists" }, 422);
      repo.refs.set(name, body.sha); return respond({ ref: body.ref }, 201);
    }
    if ((g = /^\/git\/refs\/heads\/(.+)$/.exec(rest)) && method === "DELETE") { repo.refs.delete(decodeURIComponent(g[1]!)); return respond(null, 204); }
    if ((g = /^\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(rest))) {
      const [a, b] = [g[1]!, g[2]!];
      const status = a === b ? "identical" : this.ancestors(repo, b).has(a) ? "ahead" : "diverged";
      return respond({ status, files: this.diff(this.treeOf(repo, a), this.treeOf(repo, b)) });
    }
    if ((g = /^\/contents\/(.+)$/.exec(rest))) {
      const path = decodeURIComponent(g[1]!), sha = this.resolve(repo, u.searchParams.get("ref"));
      const e = sha ? this.treeOf(repo, sha)[path] : undefined;
      if (!e) return respond({ message: "Not Found" }, 404);
      if (e.type === "commit") return respond({ type: "submodule", sha: e.sha, submodule_git_url: `https://github.com/${DATA_REPO}.git` });
      return respond({ type: "file", sha: e.sha, encoding: "base64", content: btoa(String.fromCharCode(...new TextEncoder().encode(e.content!))) });
    }
    if (rest === "/pulls" && method === "GET") {
      const head = u.searchParams.get("head")!, base = u.searchParams.get("base");
      const [, branch] = head.split(":");
      return respond(repo.pulls.filter(pr => pr.head.ref === branch && (!base || pr.base.ref === base)));
    }
    if (rest === "/pulls" && method === "POST") {
      if (repo.pulls.some(pr => pr.state === "open" && pr.head.ref === body.head && pr.base.ref === body.base)) return respond({ message: "A pull request already exists" }, 422);
      const number = repo.pulls.length + 1;
      const pr: Pull = {
        number, state: "open", merged: false, merge_commit_sha: null, title: body.title, body: body.body,
        html_url: `https://github.com/${repo.name}/pull/${number}`,
        head: { ref: body.head, sha: repo.refs.get(body.head)!, repo: { full_name: repo.name } },
        base: { ref: body.base, repo: { full_name: repo.name } },
      };
      repo.pulls.push(pr); return respond(pr, 201);
    }
    if ((g = /^\/pulls\/(\d+)$/.exec(rest))) {
      const pr = repo.pulls.find(x => x.number === Number(g![1]));
      if (!pr) return respond({}, 404);
      if (method === "PATCH") pr.state = body.state;
      return respond(pr);
    }
    if (rest === "/actions/runs") {
      const sha = u.searchParams.get("head_sha"), branch = u.searchParams.get("branch");
      return respond({ workflow_runs: repo.runs.filter(r => r.head_sha === sha && r.head_branch === branch) });
    }
    if ((g = /^\/actions\/runs\/(\d+)\/jobs$/.exec(rest))) {
      const run = repo.runs.find(r => r.id === Number(g![1]))!;
      return respond({ total_count: run.jobs.length, jobs: run.jobs });
    }
    throw new Error(`FakeGitHub: unhandled ${method} ${rest}`);
  };
}

// ---------------------------------------------------------------------------------------------
// Transcript and the demo itself.
// ---------------------------------------------------------------------------------------------
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const b64url = (bytes: Uint8Array) => b64(bytes).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
const J = (v: unknown) => JSON.stringify(v);

class Browser {
  jar = new Map<string, string>();
  constructor(private readonly e: any) {}
  async fetch(path: string, init: { method?: string; json?: unknown; headers?: Record<string, string> } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.jar.size) headers.set("Cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const method = init.method ?? "GET";
    if (method !== "GET") headers.set("Sec-Fetch-Site", "same-origin");
    if (init.json !== undefined) headers.set("Content-Type", "application/json");
    const res = await worker.fetch(new Request(new URL(path, "http://localhost").toString(), { method, headers, body: init.json === undefined ? undefined : J(init.json), redirect: "manual" }), this.e);
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(";");
      const i = pair!.indexOf("=");
      const name = pair!.slice(0, i), val = pair!.slice(i + 1);
      if (val === "" || attrs.some(a => a.trim().toLowerCase() === "max-age=0")) this.jar.delete(name); else this.jar.set(name, val);
    }
    return res;
  }
}

/** The demo. Returns the normalized transcript; every `check` is also a vitest assertion. */
async function runDemo(): Promise<string> {
  // A clean database for every run (test/setup.ts wipes per test, this also covers a second run in one test).
  for (const t of ["recorded_emails", "general_message_prs", "general_message_approvals", "general_messages", "edition_metadata_prs", "edition_metadata", "webhook_deliveries", "notification_counters", "email_suppressions", "notification_prefs", "notifications", "submission_participants", "discussion_state_log", "comment_revisions", "comments", "handle_history", "user_handles", "audit_log", "submission_reverts", "edition_items", "editions", "submission_prs", "review_state", "submission_revisions", "edition_seq", "submissions", "sessions", "oidc_flows", "test_submissions", "publication_adoptions", "membership_events", "user_roles", "memberships", "members", "users"]) await db().prepare(`DELETE FROM ${t}`).run();
  const lines: string[] = [];
  const out = (s = "") => lines.push(s);
  let stepNo = 0;
  const step = (title: string) => { out(""); out(`Step ${++stepNo}. ${title}`); out("-".repeat(Math.min(78, 6 + title.length))); };
  const note = (s: string) => out(`  ${s}`);
  /** An assertion that is also a transcript line. */
  const check = (label: string, actual: unknown, expected: unknown) => { expect(actual, label).toEqual(expected); out(`  CHECK ${label}: ${J(actual)}`); };
  const checkTrue = (label: string, cond: boolean, detail = "") => { expect(cond, label).toBe(true); out(`  CHECK ${label}${detail ? `: ${detail}` : ""}`); };

  // ---- harness: fetch interception (GitHub, Access keys, mock IdP), keys, bindings -------------
  const appKeys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", appKeys.privateKey));
  const accessKeys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const accessJwk = { ...(await crypto.subtle.exportKey("jwk", accessKeys.publicKey)), kid: "demo-access-key" };
  const github = new FakeGitHub(appKeys.publicKey);
  const outbound: string[] = [];
  const idp = new MockIdp();
  await idp.start();
  // Capture the implementation, not the mutable vi.spyOn wrapper.
  const idpFetch = idp.spy!.getMockImplementation()!;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    outbound.push(url.origin);
    if (url.origin === "https://api.github.com") return github.transport(url.toString(), init ?? {});
    if (url.origin === ACCESS_DOMAIN && url.pathname === "/cdn-cgi/access/certs") return Response.json({ keys: [accessJwk] });
    if (url.origin === ISSUER) return idpFetch(input, init); // served in process by MockIdp
    throw new Error(`demo forbids outbound network: ${url.origin}`);
  });
  clearAccessKeyCache(); resetOidcCaches();
  setEmailSender(null); setPublisher(null);

  const queued: NotifyMessage[] = [];
  const E = {
    ...env,
    AUTH_MODE: "oidc", OIDC_ISSUER: ISSUER, OIDC_CLIENT_ID: CLIENT_ID, OIDC_CLIENT_SECRET: CLIENT_SECRET,
    ACCESS_TEAM_DOMAIN: ACCESS_DOMAIN, ACCESS_AUD,
    EMAIL_PROVIDER: "recording",
    NOTIFY_Q: { send: async (body: NotifyMessage) => { queued.push(body); } },
    GITHUB_APP_ID: "424242", GITHUB_APP_INSTALLATION_ID: "777",
    GITHUB_APP_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${b64(pkcs8)}\n-----END PRIVATE KEY-----`,
    PATCH_REPO: DATA_REPO, GITHUB_SITE_REPO: SITE_REPO, GITHUB_DATA_GITLINK: "data",
    ASSETS: { fetch: async (r: Request) => {
      // The deployed register snapshot for E.164 country codes, built from the real data-ob rows.
      if (new URL(r.url).pathname === "/data/snapshots/e164-cc/current.json") return Response.json({ active_entries: E164_ROWS, lapsed_keys: [] });
      return new Response("not found", { status: 404 });
    } },
  } as any;

  // Admin API requests carry a Cloudflare Access JWT (signed by the demo's own key, JWKS served locally).
  async function accessJwt(email: string) {
    const now = Math.floor(Date.now() / 1000);
    const enc = (v: unknown) => b64url(new TextEncoder().encode(J(v)));
    const unsigned = `${enc({ alg: "RS256", kid: "demo-access-key", typ: "JWT" })}.${enc({ iss: ACCESS_DOMAIN, aud: [ACCESS_AUD], exp: now + 600, nbf: now - 10, iat: now - 10, email })}`;
    return `${unsigned}.${b64url(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", accessKeys.privateKey, new TextEncoder().encode(unsigned))))}`;
  }
  async function staff(email: string, method: string, path: string, json?: unknown) {
    const identityRequest = new Request("http://localhost", { headers: { "Cf-Access-Jwt-Assertion": await accessJwt(email) } });
    expect(await verifyAccessIdentity(identityRequest, E), "Access signature verification").toEqual({ email });
    const res = await worker.fetch(new Request(`http://localhost${path}`, { method, headers: { "Cf-Access-Jwt-Assertion": await accessJwt(email), "Sec-Fetch-Site": "same-origin", ...(json === undefined ? {} : { "Content-Type": "application/json" }) }, body: json === undefined ? undefined : J(json) }), E);
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  }
  async function member(b: Browser, method: string, path: string, json?: unknown) {
    const res = await b.fetch(path, { method, json });
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  }
  async function signIn(b: Browser, claims: Record<string, unknown>) {
    const start = await b.fetch("/auth/login?return_to=/me");
    expect(start.status).toBe(302);
    const cb = await idp.authorize(start.headers.get("Location")!, claims);
    const done = await b.fetch(cb.pathname + cb.search);
    expect(done.status).toBe(302);
    return (await (await b.fetch("/api/whoami")).json()) as any;
  }
  const one = async (sql: string, ...bind: unknown[]) => (await db().prepare(sql).bind(...bind).first<any>());
  const all = async (sql: string, ...bind: unknown[]) => (await db().prepare(sql).bind(...bind).all<any>()).results;
  const stateOf = async (id: string) => (await one("SELECT state FROM submissions WHERE id=?1", id)).state as string;
  const gh = (name: string) => github.repo(name);
  const prView = (p: Pull) => ({ repo: p.base.repo.full_name, number: p.number, state: p.merged ? "merged" : p.state, title: p.title, base: p.base.ref, head: p.head.ref });

  const ADMIN = { sub: "mock-itu-admin", email: "admin@itu.example", email_verified: true, name: "ITU Administrator" };
  const EDITOR = { sub: "mock-itu-editor", email: "editor@itu.example", email_verified: true, name: "ITU Editor" };
  const AUSTRIA = { sub: "mock-member-austria", email: "delegate@austria.example", email_verified: true, name: "Austrian Delegate" };
  const OTHER = { sub: "mock-member-belgium", email: "delegate@belgium.example", email_verified: true, name: "Belgian Delegate" };

  try {
    // ------------------------------------------------------------------------------------------
    out("ITU-OB webapp (#103) end-to-end acceptance demo");
    out("Worker: real code, real local D1 + migrations (workerd). Faked: OpenID provider, Access keys, GitHub REST API.");
    out(`Register: E164_CC (slug e164-cc), real entry country_code 43 from data-ob dataset 1114-E.164D. Edition: OB ${EDITION}.`);

    step("Operator bootstrap and country roster seed");
    for (const line of (env as any).TEST_ROSTER_SEED.committedSql.split("\n")) if (line.trim() && !line.trimStart().startsWith("--")) await db().prepare(line).run();
    const seeded = await one("SELECT count(*) n, sum(status='suspended') suspended FROM members");
    checkTrue("roster seed (seeds/roster.sql) loaded; every country starts suspended", seeded.n > 100 && seeded.n === seeded.suspended, `${seeded.n} countries, ${seeded.suspended} suspended`);
    check("austria before activation", await one("SELECT id,name,register_key,status FROM members WHERE id='austria'"), { id: "austria", name: "Austria", register_key: "Austria", status: "suspended" });
    const T = "2026-01-01T00:00:00.000Z";
    await db().prepare("INSERT INTO users (id,email,created_at) VALUES (?1,?2,?3)").bind(ADMIN.sub, ADMIN.email, T).run();
    await provisionItuStaff(db(), ADMIN.sub, ["itu-admin"], null);
    note("the first itu-admin is created by the operator directly in D1 (never over HTTP)");

    step("Mock sign-in: ITU administrator, then activate Austria");
    const adminBrowser = new Browser(E);
    const adminWho = await signIn(adminBrowser, ADMIN);
    check("admin session", { authenticated: adminWho.authenticated, roles: adminWho.roles, memberStateId: adminWho.memberStateId }, { authenticated: true, roles: ["itu-admin"], memberStateId: null });
    const noAccess = await adminBrowser.fetch("/api/admin/claims");
    check("admin API refuses a session cookie without Cloudflare Access", noAccess.status, 403);
    const activated = await staff(ADMIN.email, "POST", "/api/admin/members/austria/status", { status: "active" });
    check("POST /api/admin/members/austria/status {active}", activated.status, 200);

    step("Mock sign-in: ITU editor (inert until provisioned), provisioned by the administrator");
    const editorBrowser = new Browser(E);
    const editorFirst = await signIn(editorBrowser, EDITOR);
    check("editor before provisioning", { authenticated: editorFirst.authenticated, roles: editorFirst.roles }, { authenticated: true, roles: [] });
    check("provision itu-editor", (await staff(ADMIN.email, "POST", "/api/admin/itu-staff", { userId: EDITOR.sub, roles: ["itu-editor"] })).status, 201);
    const editorWho = await (await editorBrowser.fetch("/api/whoami")).json() as any;
    check("editor after provisioning", editorWho.roles, ["itu-editor"]);

    step("Mock sign-in: Austrian member claims Austria; staff verify the claim");
    const austria = new Browser(E);
    const first = await signIn(austria, AUSTRIA);
    check("member before claim", first.roles, []);
    const claim = await member(austria, "POST", "/api/me/membership/claim", { memberId: "austria", note: "TSB contact for Austria" });
    check("claim", [claim.status, claim.json.status], [201, "pending"]);
    check("verify claim (Access, admin)", (await staff(ADMIN.email, "POST", `/api/admin/claims/${claim.json.membershipId}/verify`, {})).status, 200);
    const mWho = await (await austria.fetch("/api/whoami")).json() as any;
    check("member session after verification", { roles: mWho.roles, memberStateId: mWho.memberStateId }, { roles: ["member-submitter"], memberStateId: "austria" });

    step("Country binding: a Belgian member cannot propose a change for Austria");
    const belgium = new Browser(E);
    await signIn(belgium, OTHER);
    await staff(ADMIN.email, "POST", "/api/admin/members/belgium/status", { status: "active" });
    const bClaim = await member(belgium, "POST", "/api/me/membership/claim", { memberId: "belgium", note: "TSB contact for Belgium" });
    check("verify Belgian claim", (await staff(ADMIN.email, "POST", `/api/admin/claims/${bClaim.json.membershipId}/verify`, {})).status, 200);
    const austriaRow = E164_ROWS.find(r => r.country_code === "43")!;
    const entry43 = { country_code: "43", country_area_or_service: austriaRow.country_area_or_service };
    check("entry taken from data-ob", austriaRow.country_area_or_service.en, "Austria");
    const forbidden = await member(belgium, "POST", "/api/me/submissions", { register_id: "E164_CC", slug: "e164-cc", action_type: "MOD", payload: { type: "MOD", data: { _class: "E164CCAmendment", entries: [entry43] } } });
    check("Belgium proposing for Austria", forbidden.status, 403);
    check("no submission was written", (await one("SELECT count(*) n FROM submissions")).n, 0);

    step("Austrian member proposes a patch; stage2 validation warns");
    note("first attempt is a mistake: ADD of country code 43, which the register already holds");
    const wrong = await member(austria, "POST", "/api/me/submissions", { register_id: "E164_CC", slug: "e164-cc", action_type: "ADD", payload: { type: "ADD", data: { _class: "E164CCAmendment", entries: [entry43] } } });
    check("create draft ADD 43", wrong.status, 201);
    check("stage2 warnings on ADD of an active key", wrong.json.warnings.map((w: any) => `${w.code}@${w.path}`), ["unknown@register_state", "mismatch@data.entries[0].country_code"]);
    out(`  stage2 conflict text: ${wrong.json.warnings.find((w: any) => w.code === "mismatch").message}`);
    check("withdraw the mistaken draft", (await member(austria, "POST", `/api/me/submissions/${wrong.json.submission.id}/withdraw`, { reason: "wrong action: the code exists, this is a modification" })).json.submission.state, "withdrawn");

    note("second attempt: MOD of the existing entry, adding an explanatory note");
    const modEntry = { ...entry43, note: { en: "Operational Bulletin demo: numbering plan note updated by the Austrian administration." } };
    const draft = await member(austria, "POST", "/api/me/submissions", { register_id: "E164_CC", slug: "e164-cc", action_type: "MOD", payload: { type: "MOD", data: { _class: "E164CCAmendment", entries: [modEntry] } } });
    check("create draft MOD 43", draft.status, 201);
    check("stage2 warnings (snapshot freshness advisory only)", draft.json.warnings.map((w: any) => `${w.code}@${w.path}`), ["unknown@register_state"]);
    const id: string = draft.json.submission.id;
    check("proposer and affiliation snapshot", await one("SELECT proposer_id,affiliation_kind,affiliation_member_id,state FROM submissions WHERE id=?1", id), { proposer_id: AUSTRIA.sub, affiliation_kind: "member", affiliation_member_id: "austria", state: "draft" });
    const originalRevision = await one("SELECT payload_yaml,payload_sha FROM submission_revisions WHERE submission_id=?1 AND rev=1", id);
    const submitted = await member(austria, "POST", `/api/me/submissions/${id}/submit`);
    check("submit", [submitted.status, submitted.json.submission.state], [200, "submitted"]);

    step("Staff review: the editor reads, starts review, asks for a change; the member revises; the editor approves");
    const listed = await staff(EDITOR.email, "GET", "/api/admin/submissions?state=submitted");
    check("editor queue", listed.json.submissions.map((s: any) => [s.id === id, s.state, s.register_id, s.action_type]), [[true, "submitted", "E164_CC", "MOD"]]);
    check("start review", (await staff(EDITOR.email, "POST", `/api/admin/submissions/${id}/start-review`, {})).json.submission.state, "in_review");
    check("request changes", (await staff(EDITOR.email, "POST", `/api/admin/submissions/${id}/request-changes`, { reason: "Please say who the note is from." })).json.submission.state, "changes_requested");
    const modEntry2 = { ...entry43, note: { en: "Operational Bulletin demo: numbering plan note updated by the Austrian administration (Bundesministerium)." } };
    const revised = await member(austria, "POST", `/api/me/submissions/${id}/revise`, { payload: { type: "MOD", data: { _class: "E164CCAmendment", entries: [modEntry2] } } });
    check("revise (revision 2 resubmitted)", [revised.status, revised.json.submission.state, revised.json.submission.current_rev], [200, "submitted", 2]);
    expect(await one("SELECT payload_yaml,payload_sha FROM submission_revisions WHERE submission_id=?1 AND rev=1", id)).toEqual(originalRevision);
    note("CHECK revision 1 bytes and hash are unchanged");
    check("both revisions remain", (await all("SELECT rev FROM submission_revisions WHERE submission_id=?1 ORDER BY rev", id)).map(r => r.rev), [1, 2]);
    check("start review again", (await staff(EDITOR.email, "POST", `/api/admin/submissions/${id}/start-review`, {})).json.submission.state, "in_review");

    step(`Approve for OB ${EDITION}: the Worker opens the patch PR on ${DATA_REPO} (never a push to main)`);
    const approved = await staff(EDITOR.email, "POST", `/api/admin/submissions/${id}/approve`, { target_edition: EDITION });
    check("approve", [approved.status, approved.json.submission.state, approved.json.pr.pr_number], [200, "pr_open", 1]);
    check("approval-time stage2 warnings", approved.json.warnings.map((w: any) => `${w.code}@${w.path}`), ["unknown@register_state"]);
    const dataRepo = gh(DATA_REPO);
    const patchPr = dataRepo.pulls[0]!;
    const branch = `rt-sub-${EDITION}-001-e164-cc-${id.slice(-8)}`;
    check("the exact PR the Worker opened", prView(patchPr), { repo: DATA_REPO, number: 1, state: "open", title: `OB-${EDITION}: MOD E164_CC`, base: "main", head: branch });
    out(`  PR title: ${patchPr.title}`);
    out(`  PR body: ${J(patchPr.body)}`);
    const patchPath = `ob-issues/${EDITION}/e164-cc/001-MOD.yaml`;
    const headTree = github.treeOf(dataRepo, patchPr.head.sha);
    check("PR changes exactly one file, an append-only patch", Object.keys(headTree), [patchPath]);
    check("main is untouched by the approval", Object.keys(github.treeOf(dataRepo, dataRepo.refs.get("main")!)), []);
    const patchYaml = headTree[patchPath]!.content!;
    out("  file content:");
    for (const l of patchYaml.trimEnd().split("\n")) out(`    | ${l}`);
    const parsed = parseYaml(patchYaml);
    check("file is the revision-2 MOD of country code 43", { type: parsed.type, reference: parsed.reference, code: parsed.identifier?.code, cls: parsed.data._class, cc: parsed.data.entries[0].country_code, note: parsed.data.entries[0].note.en.endsWith("(Bundesministerium).") }, { type: "MOD", reference: `OB-${EDITION}`, code: `${EDITION}-001`, cls: "E164CCAmendment", cc: "43", note: true });
    check("stored PR row matches the bytes sent", (await one("SELECT content_yaml,pr_number,pr_state,branch,repo,rev FROM submission_prs WHERE submission_id=?1", id)).content_yaml, patchYaml);
    check("no write ever targeted a protected branch", github.log.filter(c => c.method !== "GET" && c.path.endsWith("/git/refs")).map(c => `${c.path} ${c.body.ref}`), [`/repos/${DATA_REPO}/git/refs refs/heads/${branch}`]);

    step("Human merges the patch PR; GitHub's signed webhook moves the submission to merged");
    const patchMerge = github.humanMerge(DATA_REPO, 1);
    const raw = J({ action: "closed", repository: { full_name: DATA_REPO }, pull_request: { number: 1, merged: true, merge_commit_sha: patchMerge, head: { ref: branch, sha: patchPr.head.sha, repo: { full_name: DATA_REPO } }, base: { ref: "main" } } });
    const hmac = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.GITHUB_WEBHOOK_SECRET as string), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = [...new Uint8Array(await crypto.subtle.sign("HMAC", hmac, new TextEncoder().encode(raw)))].map(x => x.toString(16).padStart(2, "0")).join("");
    const hook = await worker.fetch(new Request("http://localhost/api/github/webhook", { method: "POST", body: raw, headers: { "Content-Type": "application/json", "X-GitHub-Event": "pull_request", "X-GitHub-Delivery": "demo-delivery-1", "X-Hub-Signature-256": `sha256=${mac}` } }), E);
    check("webhook accepted", hook.status, 200);
    check("submission state", await stateOf(id), "merged");
    check("merge commit recorded", (await one("SELECT merge_sha,pr_state FROM submission_prs WHERE submission_id=?1", id)), { merge_sha: patchMerge, pr_state: "merged" });

    step(`Compose OB ${EDITION}: admin opens the edition and places the merged item`);
    check("editor cannot compose (itu-admin only)", (await staff(EDITOR.email, "POST", "/api/admin/composer/editions", { ob_issue_no: EDITION })).status, 403);
    check("open edition", (await staff(ADMIN.email, "POST", "/api/admin/composer/editions", { ob_issue_no: EDITION })).status, 201);
    const listedMerged = await staff(ADMIN.email, "GET", "/api/admin/composer/submissions");
    check("merged-unpublished list", listedMerged.json.submissions.map((s: any) => [s.id === id, s.state, s.merge_sha === patchMerge]), [[true, "merged", true]]);
    check("place item", (await staff(ADMIN.email, "POST", `/api/admin/composer/editions/${EDITION}/items`, { submission_id: id })).json.submission.state, "scheduled");

    step("Stage (click 1): pin the data into the site's staging branch through a human-merged PR");
    check("editor cannot Stage", (await staff(EDITOR.email, "POST", `/api/admin/composer/editions/${EDITION}/stage`)).status, 403);
    const siteRepo = gh(SITE_REPO);
    const stage1 = await staff(ADMIN.email, "POST", `/api/admin/composer/editions/${EDITION}/stage`);
    check("stage -> pending (PR awaits a human)", [stage1.status, stage1.json.pending.reason, stage1.json.edition.status], [202, "Pin pull request awaits merge", "composing"]);
    const pinPr = siteRepo.pulls[0]!;
    check("the exact staging PR", prView(pinPr), { repo: SITE_REPO, number: 1, state: "open", title: `Publish bulletin ${EDITION}`, base: "staging", head: `rt-publish-${EDITION}` });
    const freeze = dataRepo.refs.get("main")!;
    check("PR changes only the data gitlink, pinning itu-ob-data main (which holds the merged patch)", [github.treeOf(siteRepo, pinPr.head.sha).data!.sha === freeze, Object.keys(github.treeOf(siteRepo, pinPr.head.sha))], [true, ["data"]]);
    check("the pinned data contains the patch", Object.keys(github.treeOf(dataRepo, freeze)), [patchPath]);
    out(`  PR body: ${J(pinPr.body)}`);
    check("item still scheduled, nothing published", [await stateOf(id), (await one("SELECT status,freeze_sha FROM editions WHERE ob_issue_no=?1", EDITION))], ["scheduled", { status: "composing", freeze_sha: null }]);
    const pinMerge = github.humanMerge(SITE_REPO, 1);
    const stage2 = await staff(ADMIN.email, "POST", `/api/admin/composer/editions/${EDITION}/stage`);
    check("PR merged but staging not deployed yet -> still pending", [stage2.status, stage2.json.pending.reason], [202, "Exact merge commit awaits successful staging deployment"]);
    github.deploy(SITE_REPO, "staging", pinMerge, "deploy-cloudflare-staging", "success");
    const stage3 = await staff(ADMIN.email, "POST", `/api/admin/composer/editions/${EDITION}/stage`);
    check("staging deploy succeeded -> staged", [stage3.status, stage3.json.edition.status, stage3.json.edition.freeze_sha === freeze, stage3.json.edition.staging_commit === pinMerge, stage3.json.published], [200, "staged", true, true, []]);
    check("item still scheduled: Stage publishes nothing", [await stateOf(id), (await one("SELECT published_at FROM editions")).published_at], ["scheduled", null]);

    step("Publish (click 2): open the staging -> main PR on the site repository (the Worker never merges)");
    check("editor cannot Publish", (await staff(EDITOR.email, "POST", `/api/admin/composer/editions/${EDITION}/publish`)).status, 403);
    const pub1 = await staff(ADMIN.email, "POST", `/api/admin/composer/editions/${EDITION}/publish`);
    check("publish -> pending (PR awaits a human)", [pub1.status, pub1.json.pending.reason, pub1.json.edition.status], [202, "Promotion pull request awaits merge", "staged"]);
    const promoPr = siteRepo.pulls[1]!;
    check("the exact production PR", prView(promoPr), { repo: SITE_REPO, number: 2, state: "open", title: `Publish bulletin ${EDITION}`, base: "main", head: "staging" });
    out(`  PR body: ${J(promoPr.body)}`);
    check("exactly one promotion PR, staging pins the frozen data", [siteRepo.pulls.filter(p => p.base.ref === "main").length, github.treeOf(siteRepo, siteRepo.refs.get("staging")!).data!.sha === freeze], [1, true]);
    check("production is unchanged until a human merges", github.treeOf(siteRepo, siteRepo.refs.get("main")!).data!.sha !== freeze, true);
    check("item scheduled, edition staged", [await stateOf(id), (await one("SELECT status FROM editions")).status], ["scheduled", "staged"]);
    const promoMerge = github.humanMerge(SITE_REPO, 2);
    const pub2 = await staff(ADMIN.email, "POST", `/api/admin/composer/editions/${EDITION}/publish`);
    check("PR merged but production not deployed yet -> still pending", [pub2.status, pub2.json.pending.reason], [202, "Exact merge commit awaits successful production deployment"]);
    check("idempotent: still one promotion PR", siteRepo.pulls.filter(p => p.base.ref === "main").length, 1);
    github.deploy(SITE_REPO, "main", promoMerge, "deploy-cloudflare-production", "success");
    const pub3 = await staff(ADMIN.email, "POST", `/api/admin/composer/editions/${EDITION}/publish`);
    check("production deploy succeeded -> published", [pub3.status, pub3.json.edition.status, pub3.json.published.length, pub3.json.published[0] === id], [200, "published", 1, true]);
    check("submission is published", await stateOf(id), "published");
    check("production pins the frozen data", github.treeOf(siteRepo, siteRepo.refs.get("main")!).data!.sha === freeze, true);
    check("publish again is refused", (await staff(ADMIN.email, "POST", `/api/admin/composer/editions/${EDITION}/publish`)).status, 409);

    step("State history and audit trail");
    const hist = await all("SELECT from_state,to_state,actor_kind FROM review_state WHERE submission_id=?1 ORDER BY id", id);
    out("  submission state history:");
    for (const h of hist) out(`    ${h.from_state ?? "(new)"} -> ${h.to_state}  [${h.actor_kind}]`);
    check("history reaches published", hist.at(-1)!.to_state, "published");
    const audits = await all("SELECT action FROM audit_log WHERE action LIKE 'edition.%' OR action LIKE 'composer.%' OR action LIKE 'github.%' ORDER BY id");
    check("composer and GitHub audit entries", audits.map(a => a.action), ["github.pull_request.merged", "edition.created", "composer.placed", "edition.staged", "composer.published", "edition.published"]);
    checkTrue("audit hash chain verifies", (await verifyChain(db())) === null, "verifyChain -> null (no break)");

    step("Notification outbox and recorded email");
    const notes = await all("SELECT n.kind, u.email, n.email_status FROM notifications n JOIN users u ON u.id=n.user_id WHERE n.submission_id=?1", id);
    const byKind = new Map<string, string[]>();
    for (const n of notes) byKind.set(n.kind, [...(byKind.get(n.kind) ?? []), n.email]);
    out("  notification rows for the submission (kind -> recipients):");
    for (const k of [...byKind.keys()].sort()) out(`    ${k} -> ${byKind.get(k)!.sort().join(", ")}`);
    checkTrue("the member is told about review, approval, PR merge and publication", ["submission.changes_requested", "submission.approved", "submission.pr_opened", "submission.pr_merged", "submission.published"].every(k => byKind.get(k)?.includes(AUSTRIA.email)), "changes_requested, approved, pr_opened, pr_merged, published");
    const queueCount = queued.length;
    const delivered = await consumeAll();
    out(`  queue messages handed to the consumer: ${queueCount}; delivered by the consumer: ${delivered}`);
    const recorded = (await staff(ADMIN.email, "GET", "/api/admin/recorded-emails?limit=100")).json.emails as any[];
    checkTrue("mail was recorded, never sent", recorded.length > 0 && recorded.every(m => m.id.startsWith("recording-")), `${recorded.length} recorded emails`);
    const subjectsTo = (to: string) => recorded.filter(m => m.to_address === to).map(m => m.subject).sort();
    out("  recorded emails (recipient: subjects):");
    for (const to of [...new Set(recorded.map(m => m.to_address))].sort()) for (const s of subjectsTo(to)) out(`    ${to}: ${s}`);
    const pubMail = recorded.find(m => m.to_address === AUSTRIA.email && m.subject.toLowerCase().includes("publish"));
    checkTrue("the member's publication email exists and links to the discussion", !!pubMail && pubMail.text_body.includes("/me/discussions/?id="));
    check("every notification row ended sent or skipped, none failed", (await all("SELECT DISTINCT email_status s FROM notifications ORDER BY s")).map(r => r.s), ["sent"]);

    step("Boundaries");
    check("hosts the Worker contacted", [...new Set(outbound)].sort(), [ACCESS_DOMAIN, "https://api.github.com", ISSUER].sort());
    check("GitHub writes by the Worker (method path)", [...new Set(github.log.filter(c => c.method !== "GET").map(c => `${c.method} ${c.path.replace(/\/\d+$/, "/N")}`))].sort(), [
      `POST /app/installations/777/access_tokens`,
      `POST /repos/${DATA_REPO}/git/commits`, `POST /repos/${DATA_REPO}/git/refs`, `POST /repos/${DATA_REPO}/git/trees`, `POST /repos/${DATA_REPO}/pulls`,
      `POST /repos/${SITE_REPO}/git/commits`, `POST /repos/${SITE_REPO}/git/refs`, `POST /repos/${SITE_REPO}/git/trees`, `POST /repos/${SITE_REPO}/pulls`,
    ].sort());
    check("no merge, no PATCH, no ref update or delete was ever issued by the Worker", github.log.filter(c => c.method === "PATCH" || c.method === "DELETE" || c.method === "PUT" || c.path.includes("/merge")).length, 0);
    out("");
    out("Not exercised here (see docs/acceptance/103-end-to-end-demo.adoc): replay regenerating projections from the merged patch, and the staging/production site builds.");
  } finally {
    idp.stop();
    spy.mockRestore();
    setPublisher(null); setEmailSender(null);
  }

  async function consumeAll(): Promise<number> {
    let delivered = 0;
    for (const body of queued.splice(0)) {
      const batch = createMessageBatch("ituob-notify", [{ id: `m${delivered}`, timestamp: new Date(), attempts: 1, body }]);
      await worker.queue(batch, E);
      await getQueueResult(batch, createExecutionContext());
      delivered += body.notification_ids.length;
    }
    return delivered;
  }
  return normalize(lines.join("\n") + "\n");
}

/** Replace run-specific values (ULIDs, timestamps and selection digests) with stable placeholders so the transcript is reproducible. */
function normalize(text: string): string {
  const ulids = new Map<string, string>();
  const suffixes = new Map<string, string>();
  let out = text.replace(/\b[0-9A-HJKMNP-TV-Z]{26}\b/g, m => {
    if (!ulids.has(m)) { ulids.set(m, `<sub-${ulids.size + 1}>`); suffixes.set(m.slice(-8), `<sub-${ulids.size}-suffix>`); }
    return ulids.get(m)!;
  });
  for (const [suffix, label] of suffixes) out = out.split(suffix).join(label);
  out = out.replace(/\b20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z\b/g, "<time>");
  // The pin selection digest includes the randomly generated submission ID.
  out = out.replace(/ituob-publication:[A-Za-z0-9_-]{43}/g, "ituob-publication:<selection-digest>");
  return out;
}

afterEach(() => { vi.restoreAllMocks(); });

describe("#103 end-to-end acceptance demo", () => {
  it("member submits -> staff review -> approve -> Stage -> Publish -> published, with notifications; records the transcript", async () => {
    const transcript = await runDemo();
    await expect(transcript).toMatchFileSnapshot(TRANSCRIPT_FILE);
  });

  it("is reproducible: a second run on a clean database produces the identical transcript", async () => {
    const first = await runDemo();
    expect(await runDemo()).toBe(first);
  });
});
