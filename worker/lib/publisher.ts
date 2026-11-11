// Approval -> branch -> PR, behind an interface (docs/submission-workflow.adoc
// "Approval -> branch -> PR"). The real GitHub App client is not built here;
// tests use FakePatchPublisher. NOTHING in this layer may target `main`.

export interface OpenPatchPrRequest {
  repo: string;
  /** Always `rt-sub-*`; the idempotency key. */
  branch: string;
  path: string;
  content: string;
  title: string;
  body: string;
  idempotencyKey: string;
}
export interface OpenedPr {
  prNumber: number;
  commitSha: string;
  baseSha: string;
  url: string;
}
export interface PatchPublisher {
  /** Idempotent per `idempotencyKey`: a replay returns the same PR, never a second. */
  openPatchPr(req: OpenPatchPrRequest): Promise<OpenedPr>;
  /** Close the PR and delete the Worker-created branch (never merges, never touches other refs). */
  closePatchPr(req: { repo: string; branch: string; prNumber: number }): Promise<void>;
}

export class PublisherNotConfigured extends Error {
  constructor() {
    super("not configured");
  }
}

export const PATCH_BRANCH = /^rt-sub-\d+-\d{3}-[a-z0-9-]+-[0-9A-Z]{8}$/;

/** The single guard every publisher implementation calls first. */
export function assertPatchBranch(branch: string): void {
  if (!PATCH_BRANCH.test(branch)) throw new Error(`refusing branch ${JSON.stringify(branch)}: only rt-sub-* patch branches are writable`);
}

export function branchName(issue: number, seq: number, slug: string, submissionId: string): string {
  const nnn = String(seq).padStart(3, "0");
  const s = slug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `rt-sub-${issue}-${nnn}-${s}-${submissionId.slice(-8)}`;
}

/** Real GitHub App implementation: a stub until the App exists (account setup, see design note). */
export class GitHubAppPatchPublisher implements PatchPublisher {
  async openPatchPr(_req: OpenPatchPrRequest): Promise<OpenedPr> {
    throw new PublisherNotConfigured();
  }
  async closePatchPr(): Promise<void> {
    throw new PublisherNotConfigured();
  }
}

export class FakePatchPublisher implements PatchPublisher {
  readonly requests: OpenPatchPrRequest[] = [];
  readonly closed: { repo: string; branch: string; prNumber: number }[] = [];
  private byKey = new Map<string, OpenedPr>();
  private next = 1;
  /** Fail the next N openPatchPr calls (simulates 5xx), then recover. */
  failNext = 0;
  /** Test seam: runs after the PR exists upstream, before openPatchPr returns (simulates a concurrent actor). */
  failClose = false;
  afterCreate: ((pr: OpenedPr) => Promise<void>) | null = null;

  async openPatchPr(req: OpenPatchPrRequest): Promise<OpenedPr> {
    assertPatchBranch(req.branch);
    this.requests.push(req);
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("GitHub 502");
    }
    const hit = this.byKey.get(req.idempotencyKey);
    if (hit) return hit;
    const n = this.next++;
    const pr = { prNumber: n, commitSha: `c${n}`.padEnd(40, "0"), baseSha: "b".repeat(40), url: `https://github.invalid/${req.repo}/pull/${n}` };
    this.byKey.set(req.idempotencyKey, pr);
    if (this.afterCreate) await this.afterCreate(pr);
    return pr;
  }
  async closePatchPr(req: { repo: string; branch: string; prNumber: number }): Promise<void> {
    assertPatchBranch(req.branch);
    if (this.failClose) throw new Error("GitHub 502 on close");
    this.closed.push(req);
  }
  get createdPrs(): number {
    return this.byKey.size;
  }
}

let override: PatchPublisher | null = null;
/** Test seam / future wiring point. Production resolves the (unconfigured) App client. */
export function setPublisher(p: PatchPublisher | null) {
  override = p;
}
export function getPublisher(): PatchPublisher {
  return override ?? new GitHubAppPatchPublisher();
}
